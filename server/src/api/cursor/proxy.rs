//! Selects local handling or the configured official Cursor upstream.
use std::time::Instant;

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::Extension,
    http::{header, HeaderValue, Request, Response},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use bytes::{BufMut, BytesMut};
use sha2::{Digest, Sha256};

use crate::Result;

const CURSOR_UPSTREAM: &str = "https://api2.cursor.sh";
pub const UPSTREAM_URL_HEADER: &str = "x-server-upstream-url";

#[derive(Clone)]
pub struct CursorProxy {
    clients: crate::network::NetworkClients,
    upstream: String,
}

pub struct BufferedResponse {
    pub status: axum::http::StatusCode,
    pub headers: axum::http::HeaderMap,
    pub body: Bytes,
}

impl BufferedResponse {
    pub fn into_response(self) -> Response<Body> {
        let body = self.body.clone();
        self.with_body(body)
    }

    pub fn with_body(mut self, body: Bytes) -> Response<Body> {
        self.headers.insert(
            header::CONTENT_LENGTH,
            body.len()
                .to_string()
                .parse()
                .expect("body length is always a valid header value"),
        );
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = self.status;
        *response.headers_mut() = self.headers;
        response
    }
}

impl CursorProxy {
    pub fn cursor(clients: crate::network::NetworkClients) -> Self {
        Self {
            clients,
            upstream: CURSOR_UPSTREAM.into(),
        }
    }

    async fn client(&self) -> Result<reqwest::Client> {
        self.clients.cursor_client().await
    }
}

/// Everything a user-provided TAB service needs to serve a forwarded RPC.
pub(crate) struct TabServiceAuth<'a> {
    pub url: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
}

/// TAB RPCs whose request message carries `model_name` at protobuf field 3.
/// Rewriting it is how the selected model reaches the service; every other
/// field of the message stays byte-identical.
const MODEL_NAME_PATHS: [&str; 2] = [
    "/aiserver.v1.AiService/StreamCpp",
    "/aiserver.v1.AiService/StreamNextCursorPrediction",
];
const MODEL_NAME_FIELD: u64 = 3;

pub async fn forward(
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    forward_request(&proxy, request, None).await
}

pub(crate) async fn forward_to_service(
    proxy: &CursorProxy,
    request: Request<Body>,
    service: TabServiceAuth<'_>,
) -> Result<Response<Body>> {
    forward_request(proxy, request, Some(service)).await
}

async fn forward_request(
    proxy: &CursorProxy,
    request: Request<Body>,
    service: Option<TabServiceAuth<'_>>,
) -> Result<Response<Body>> {
    let started = Instant::now();
    let (parts, body) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |value| value.as_str())
        .to_owned();
    let url = match &service {
        Some(service) => format!("{}{}", service.url.trim_end_matches('/'), path),
        None => upstream_url(&parts.headers, &proxy.upstream, &path)?,
    };

    let mut headers = parts.headers;
    headers.remove(UPSTREAM_URL_HEADER);
    headers.remove(header::HOST);
    remove_hop_by_hop_headers(&mut headers);

    let body = match &service {
        Some(service) => {
            apply_service_auth(&mut headers, service.api_key);
            let model = service.model.trim();
            if model.is_empty() || !MODEL_NAME_PATHS.contains(&parts.uri.path()) {
                body
            } else {
                let bytes = to_bytes(body, usize::MAX).await.map_err(|error| {
                    crate::Error::Protocol(format!("cannot read TAB request body: {error}"))
                })?;
                match with_model_name(&bytes, model) {
                    Some(rewritten) => {
                        headers.remove(header::CONTENT_LENGTH);
                        Body::from(rewritten)
                    }
                    None => {
                        tracing::warn!(path, model, "TAB request body is not a protobuf message");
                        Body::from(bytes)
                    }
                }
            }
        }
        None => body,
    };

    let client = proxy.client().await?;
    let upstream = client
        .request(parts.method.clone(), url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await;

    let upstream = match upstream {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(
                method = %parts.method,
                path,
                elapsed_ms = started.elapsed().as_millis(),
                %error,
                "Cursor upstream request failed"
            );
            return Err(error.into());
        }
    };

    let status = upstream.status();
    let mut response_headers = upstream.headers().clone();
    remove_hop_by_hop_headers(&mut response_headers);
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;

    tracing::info!(
        method = %parts.method,
        path,
        %status,
        elapsed_ms = started.elapsed().as_millis(),
        "forwarded Cursor backend request"
    );
    Ok(response)
}

pub async fn forward_buffered(
    proxy: &CursorProxy,
    request: Request<Body>,
) -> Result<BufferedResponse> {
    let (parts, body) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |value| value.as_str());
    let url = upstream_url(&parts.headers, &proxy.upstream, path)?;
    let mut headers = parts.headers;
    headers.remove(UPSTREAM_URL_HEADER);
    headers.remove(header::HOST);
    remove_hop_by_hop_headers(&mut headers);
    headers.insert(
        "connect-accept-encoding",
        axum::http::HeaderValue::from_static("identity"),
    );
    headers.insert(
        header::ACCEPT_ENCODING,
        axum::http::HeaderValue::from_static("identity"),
    );
    let body = to_bytes(body, usize::MAX)
        .await
        .map_err(|error| crate::Error::Protocol(format!("cannot read request body: {error}")))?;
    let upstream = proxy
        .client()
        .await?
        .request(parts.method, url)
        .headers(headers)
        .body(body)
        .send()
        .await?;
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    remove_hop_by_hop_headers(&mut headers);
    let body = upstream.bytes().await?;
    Ok(BufferedResponse {
        status,
        headers,
        body,
    })
}

fn upstream_url(headers: &axum::http::HeaderMap, fallback: &str, path: &str) -> Result<String> {
    let Some(value) = headers.get(UPSTREAM_URL_HEADER) else {
        return Ok(format!("{fallback}{path}"));
    };
    let value = value
        .to_str()
        .map_err(|error| crate::Error::Protocol(format!("invalid upstream URL header: {error}")))?;
    let url = reqwest::Url::parse(value)
        .map_err(|error| crate::Error::Protocol(format!("invalid upstream URL: {error}")))?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !crate::local_app::proxy_host_allowed(host) {
        return Err(crate::Error::Protocol(
            "upstream URL must target a Cursor HTTPS host".into(),
        ));
    }
    Ok(url.into())
}

fn remove_hop_by_hop_headers(headers: &mut axum::http::HeaderMap) {
    let connection_headers = headers
        .get(header::CONNECTION)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for name in connection_headers {
        headers.remove(name);
    }
    for name in [
        header::CONNECTION,
        header::PROXY_AUTHENTICATE,
        header::PROXY_AUTHORIZATION,
        header::TE,
        header::TRAILER,
        header::TRANSFER_ENCODING,
        header::UPGRADE,
    ] {
        headers.remove(name);
    }
    headers.remove("keep-alive");
}

/// Replaces Cursor's own credential with the TAB service key.
///
/// Compatible TAB services authenticate the forwarded RPC the same way Cursor
/// does, so the checksum has to be derived from the key that is actually sent.
fn apply_service_auth(headers: &mut axum::http::HeaderMap, api_key: &str) {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return;
    }
    let authorization = if api_key.to_ascii_lowercase().starts_with("bearer ") {
        api_key.to_owned()
    } else {
        format!("Bearer {api_key}")
    };
    let (Ok(value), Ok(checksum)) = (
        HeaderValue::from_str(&authorization),
        HeaderValue::from_str(&cursor_checksum(&authorization)),
    ) else {
        tracing::warn!("TAB service key is not a valid HTTP header value");
        return;
    };
    headers.insert(header::AUTHORIZATION, value);
    headers.insert("x-cursor-checksum", checksum);
}

/// Builds the `x-cursor-checksum` value Cursor clients send: a six byte
/// timestamp prefix mixed with a seed, followed by the first 32 hex characters
/// of the SHA-256 digest of the authorization value.
fn cursor_checksum(authorization: &str) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64 / 1_000_000)
        .unwrap_or_default();
    let mut prefix_bytes = [0u8; 6];
    for (index, byte) in prefix_bytes.iter_mut().enumerate() {
        *byte = ((timestamp >> ((5 - index) * 8)) & 0xff) as u8;
    }
    let mut seed = 165u16;
    for (index, byte) in prefix_bytes.iter_mut().enumerate() {
        let mixed = (((*byte as u16) ^ seed).wrapping_add(index as u16 % 256)) & 0xff;
        *byte = mixed as u8;
        seed = mixed;
    }
    let prefix = BASE64.encode(prefix_bytes);
    let digest = Sha256::digest(authorization.trim().as_bytes());
    format!(
        "{}{}",
        prefix.trim_end_matches('='),
        &hex::encode(digest)[..32]
    )
}

/// Rewrites `model_name` (field 3) of a TAB request protobuf.
///
/// Returns `None` when the body does not parse as a protobuf message, which
/// keeps malformed or non-protobuf traffic forwarding unchanged instead of
/// failing the RPC.
fn with_model_name(body: &[u8], model: &str) -> Option<Bytes> {
    let mut out = BytesMut::with_capacity(body.len() + model.len() + 8);
    let mut offset = 0usize;
    let mut replaced = false;
    while offset < body.len() {
        let field_start = offset;
        let tag = read_varint(body, &mut offset)?;
        let field = tag >> 3;
        let wire = tag & 0x7;
        if field == MODEL_NAME_FIELD && wire == 2 {
            let length = usize::try_from(read_varint(body, &mut offset)?).ok()?;
            offset = offset.checked_add(length)?;
            if offset > body.len() {
                return None;
            }
            write_varint(&mut out, tag);
            write_varint(&mut out, model.len() as u64);
            out.extend_from_slice(model.as_bytes());
            replaced = true;
            continue;
        }
        skip_value(body, &mut offset, wire)?;
        out.extend_from_slice(&body[field_start..offset]);
    }
    if !replaced {
        write_varint(&mut out, (MODEL_NAME_FIELD << 3) | 2);
        write_varint(&mut out, model.len() as u64);
        out.extend_from_slice(model.as_bytes());
    }
    Some(out.freeze())
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*offset)?;
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn write_varint(out: &mut BytesMut, mut value: u64) {
    while value >= 0x80 {
        out.put_u8((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.put_u8(value as u8);
}

fn skip_value(bytes: &[u8], offset: &mut usize, wire: u64) -> Option<()> {
    let size = match wire {
        0 => {
            read_varint(bytes, offset)?;
            0
        }
        1 => 8,
        2 => usize::try_from(read_varint(bytes, offset)?).ok()?,
        5 => 4,
        _ => return None,
    };
    *offset = offset.checked_add(size)?;
    if *offset > bytes.len() {
        return None;
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::{cursor_checksum, with_model_name};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use bytes::BytesMut;
    use sha2::{Digest, Sha256};

    fn varint(out: &mut BytesMut, mut value: u64) {
        while value >= 0x80 {
            out.extend_from_slice(&[((value as u8) & 0x7f) | 0x80]);
            value >>= 7;
        }
        out.extend_from_slice(&[value as u8]);
    }

    fn string_field(out: &mut BytesMut, field: u64, value: &[u8]) {
        varint(out, (field << 3) | 2);
        varint(out, value.len() as u64);
        out.extend_from_slice(value);
    }

    #[test]
    fn the_selected_model_replaces_the_original_one_and_keeps_other_fields() {
        let mut body = BytesMut::new();
        string_field(&mut body, 1, b"current-file");
        string_field(&mut body, 3, b"default-model");
        varint(&mut body, (10 << 3) | 0);
        varint(&mut body, 1);

        let rewritten = with_model_name(&body, "qwen3-coder").unwrap();
        let mut expected = BytesMut::new();
        string_field(&mut expected, 1, b"current-file");
        string_field(&mut expected, 3, b"qwen3-coder");
        varint(&mut expected, (10 << 3) | 0);
        varint(&mut expected, 1);

        assert_eq!(rewritten, expected.freeze());
    }

    #[test]
    fn a_request_without_a_model_field_gains_one() {
        let mut body = BytesMut::new();
        string_field(&mut body, 1, b"current-file");

        let rewritten = with_model_name(&body, "qwen3-coder").unwrap();
        let mut expected = body.clone();
        string_field(&mut expected, 3, b"qwen3-coder");

        assert_eq!(rewritten, expected.freeze());
    }

    #[test]
    fn a_body_that_is_not_protobuf_is_left_alone() {
        assert!(with_model_name(&[0x1a], "model").is_none());
        assert!(with_model_name(&[0xff, 0xff, 0xff], "model").is_none());
        assert!(with_model_name(&[(3 << 3) | 2, 9, b'a'], "model").is_none());
    }

    #[test]
    fn the_checksum_prefix_and_digest_follow_the_authorization_value() {
        let checksum = cursor_checksum("Bearer tab-key");
        assert_eq!(checksum.len(), 8 + 32);

        let (prefix, hash) = checksum.split_at(8);
        assert_eq!(
            BASE64.decode(prefix).unwrap().len(),
            6,
            "timestamp prefix must decode to six bytes"
        );
        let digest = hex::encode(Sha256::digest(b"Bearer tab-key"));
        assert_eq!(hash, &digest[..32]);
    }
}
