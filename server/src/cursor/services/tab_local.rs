//! Answers Cursor TAB completions locally with a configured model.
//!
//! Cursor sends `aiserver.v1.AiService/StreamCpp` with the current file and the
//! cursor position. `Local` TAB mode decodes that request, asks the configured
//! model to continue the code, and replies with one `StreamCppResponse` frame
//! carrying the whole suggestion. Every other TAB RPC keeps going to the
//! official Cursor endpoint, so cursor prediction and config stay untouched.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, Response},
};
use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::{
    cursor::{protocol::connect, transport::TransportRegistry},
    model::{
        ContentPart, ModelInvocation, ModelRequest, ModelSpec, ProjectedContent, ProjectedMessage,
        PromptSpec, Role,
    },
    provider::{ModelEvent, Provider},
    store::TabSettings,
    Error, Result,
};

pub const STREAM_CPP_PATH: &str = "/aiserver.v1.AiService/StreamCpp";

const SYSTEM_PROMPT: &str = "You are a code completion engine inside an IDE. \
Continue the code at the <CURSOR/> marker. Reply with ONLY the code to insert: \
no prose, no markdown fences, no repetition of surrounding code. \
Keep it under six lines and match the indentation and style of the file.";

const PREFIX_LIMIT: usize = 8_000;
const SUFFIX_LIMIT: usize = 2_000;
const MAX_OUTPUT_TOKENS: u64 = 512;
const GENERATION_TIMEOUT: Duration = Duration::from_secs(12);
const SUGGESTION_CHAR_LIMIT: usize = 2_000;
const SUGGESTION_LINE_LIMIT: usize = 12;

pub async fn stream_cpp(
    registry: &TransportRegistry,
    request: Request<Body>,
    settings: &TabSettings,
) -> Result<Response<Body>> {
    let budget = request
        .headers()
        .get("connect-timeout-ms")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .map(|timeout| timeout.saturating_sub(Duration::from_millis(500)))
        .filter(|timeout| !timeout.is_zero())
        .map_or(GENERATION_TIMEOUT, |timeout| {
            timeout.min(GENERATION_TIMEOUT)
        });
    let body = to_bytes(request.into_body(), usize::MAX)
        .await
        .map_err(|error| Error::Protocol(format!("cannot read StreamCpp body: {error}")))?;
    let parsed = parse_stream_cpp(first_payload(&body))?;
    let completion = match complete(registry, settings, &parsed, budget).await {
        Ok(text) => text,
        Err(error) => {
            // 补全失败不该让 Cursor 弹错，退化成空建议即可。
            tracing::warn!(%error, "local TAB completion failed");
            String::new()
        }
    };
    let mut frames = frame(&encode_stream_cpp_response(&completion, true));
    frames.extend_from_slice(&connect::encode_end_stream());
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/connect+proto")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("connect-protocol-version", "1")
        .body(Body::from(frames))
        .expect("static TAB response"))
}

async fn complete(
    registry: &TransportRegistry,
    settings: &TabSettings,
    request: &TabRequest,
    budget: Duration,
) -> Result<String> {
    let model_hash = resolve_model(registry, &settings.model).await?;
    let (prefix, suffix) = split_at_cursor(request);
    let invocation = invocation(&model_hash, &user_content(request, &prefix, &suffix));
    let provider = registry.conversations().dependencies().provider.clone();
    let raw = generate(provider, invocation, budget).await?;
    Ok(clean_suggestion(&raw, &prefix))
}

/// Accepts the configured model hash, its upstream model name, or a plugin
/// model's stable `plugin:<plugin>/<provider>/<model>` ID, so the TAB model
/// field can stay a plain, human-readable name for built-in models.
async fn resolve_model(registry: &TransportRegistry, wanted: &str) -> Result<String> {
    if wanted.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
        return resolve_plugin_model(registry, wanted).await;
    }
    if let Some(model) = registry.store().model(wanted).await? {
        return Ok(model.model_hash);
    }
    let models = registry.store().models().await?;
    models
        .into_iter()
        .find(|model| model.model_id == wanted)
        .map(|model| model.model_hash)
        .ok_or_else(|| {
            Error::Provider(format!(
                "TAB model {wanted} is not configured; pick a configured model in the TAB settings"
            ))
        })
}

/// Plugin models are addressed by their stable ID and routed by the provider
/// router, so the composite ID is passed through unchanged as the model hash.
async fn resolve_plugin_model(registry: &TransportRegistry, wanted: &str) -> Result<String> {
    let plugins = registry
        .plugins()
        .ok_or_else(|| Error::Provider("plugin models are unavailable on this build".into()))?;
    let configured = plugins.configured_models().await;
    if configured.iter().any(|model| model.id == wanted) {
        return Ok(wanted.to_owned());
    }
    // 已安装但未启用的模型也会报同一句，避免只给「未配置」的模糊提示。
    if plugins.model_descriptor(wanted).await.is_ok() {
        return Err(Error::Provider(format!(
            "plugin model {wanted} is installed but not enabled; enable it in the plugin page"
        )));
    }
    Err(Error::Provider(format!(
        "TAB model {wanted} is not an enabled plugin model; pick one in the TAB settings"
    )))
}

fn invocation(model_hash: &str, user_content: &str) -> ModelInvocation {
    let call_id = format!("tab-cpp-{}", uuid::Uuid::new_v4());
    ModelInvocation {
        call_id: call_id.clone(),
        run_id: call_id.clone(),
        conversation_id: call_id,
        provider_call_index: 0,
        request: ModelRequest {
            prompt: PromptSpec {
                instructions: SYSTEM_PROMPT.to_owned(),
                tools: Vec::new(),
            },
            model: ModelSpec {
                max_output_tokens: Some(MAX_OUTPUT_TOKENS),
                ..ModelSpec::new(model_hash.to_owned())
            },
            history: vec![ProjectedMessage {
                message_id: "tab-cpp".into(),
                role: Role::User,
                content: ProjectedContent::Parts(vec![ContentPart::Text {
                    text: user_content.to_owned(),
                }]),
            }],
        },
    }
}

/// The subset of `StreamCppRequest` this service needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct TabRequest {
    path: String,
    language: String,
    contents: String,
    line: u32,
    column: u32,
}

async fn generate(
    provider: Arc<dyn Provider>,
    invocation: ModelInvocation,
    budget: Duration,
) -> Result<String> {
    let cancellation = CancellationToken::new();
    let stream = provider.stream(invocation, cancellation.clone());
    let mut accumulated = String::new();
    let deadline = Instant::now() + budget;
    let completed = tokio::time::timeout(budget, async {
        futures_util::pin_mut!(stream);
        loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                break;
            }
            match tokio::time::timeout(wait, stream.next()).await {
                Err(_) | Ok(None) => break,
                Ok(Some(event)) => match event? {
                    ModelEvent::TextDelta(delta) => accumulated.push_str(&delta),
                    ModelEvent::Done(_) => break,
                    _ => {}
                },
            }
        }
        Ok::<(), Error>(())
    })
    .await;
    match completed {
        Ok(result) => {
            result?;
            Ok(accumulated)
        }
        Err(_) => {
            cancellation.cancel();
            Err(Error::Provider("local TAB completion timed out".into()))
        }
    }
}

/// Connect clients may wrap the message in a length-prefixed envelope; raw
/// protobuf bodies are accepted as-is.
fn first_payload(body: &[u8]) -> &[u8] {
    if body.len() >= 5 {
        let length = u32::from_be_bytes([body[1], body[2], body[3], body[4]]) as usize;
        if body[0] & connect::END_STREAM_FLAG == 0 && length == body.len() - 5 {
            return &body[5..];
        }
    }
    body
}

fn parse_stream_cpp(bytes: &[u8]) -> Result<TabRequest> {
    let mut request = TabRequest::default();
    let mut index = 0usize;
    while index < bytes.len() {
        let tag = read_varint(bytes, &mut index)
            .ok_or_else(|| Error::Protocol("truncated StreamCppRequest".into()))?;
        let field = tag >> 3;
        let wire = (tag & 7) as u8;
        if field == 1 && wire == 2 {
            let file = read_bytes(bytes, &mut index)
                .ok_or_else(|| Error::Protocol("truncated current file".into()))?;
            parse_current_file(file, &mut request)?;
        } else if skip_field(bytes, &mut index, wire).is_none() {
            return Err(Error::Protocol("truncated StreamCppRequest field".into()));
        }
    }
    Ok(request)
}

fn parse_current_file(bytes: &[u8], request: &mut TabRequest) -> Result<()> {
    let mut index = 0usize;
    while index < bytes.len() {
        let tag = read_varint(bytes, &mut index)
            .ok_or_else(|| Error::Protocol("truncated CurrentFileInfo".into()))?;
        let field = tag >> 3;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 2) => request.path = read_string(bytes, &mut index)?,
            (2, 2) => request.contents = read_string(bytes, &mut index)?,
            (3, 2) => {
                let position = read_bytes(bytes, &mut index)
                    .ok_or_else(|| Error::Protocol("truncated cursor position".into()))?;
                parse_cursor_position(position, request)?;
            }
            (5, 2) => request.language = read_string(bytes, &mut index)?,
            _ => {
                if skip_field(bytes, &mut index, wire).is_none() {
                    return Err(Error::Protocol("truncated CurrentFileInfo field".into()));
                }
            }
        }
    }
    Ok(())
}

fn parse_cursor_position(bytes: &[u8], request: &mut TabRequest) -> Result<()> {
    let mut index = 0usize;
    while index < bytes.len() {
        let tag = read_varint(bytes, &mut index)
            .ok_or_else(|| Error::Protocol("truncated CursorPosition".into()))?;
        let field = tag >> 3;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => {
                request.line = read_varint(bytes, &mut index)
                    .ok_or_else(|| Error::Protocol("truncated cursor line".into()))?
                    as u32
            }
            (2, 0) => {
                request.column = read_varint(bytes, &mut index)
                    .ok_or_else(|| Error::Protocol("truncated cursor column".into()))?
                    as u32
            }
            _ => {
                if skip_field(bytes, &mut index, wire).is_none() {
                    return Err(Error::Protocol("truncated CursorPosition field".into()));
                }
            }
        }
    }
    Ok(())
}

fn read_varint(input: &[u8], index: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0u32;
    while let Some(byte) = input.get(*index) {
        *index += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

fn read_bytes<'a>(input: &'a [u8], index: &mut usize) -> Option<&'a [u8]> {
    let length = read_varint(input, index)? as usize;
    let end = index.checked_add(length)?;
    let slice = input.get(*index..end)?;
    *index = end;
    Some(slice)
}

fn read_string(input: &[u8], index: &mut usize) -> Result<String> {
    let bytes =
        read_bytes(input, index).ok_or_else(|| Error::Protocol("truncated string field".into()))?;
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

fn skip_field(input: &[u8], index: &mut usize, wire: u8) -> Option<()> {
    match wire {
        0 => read_varint(input, index).map(|_| ()),
        1 => {
            *index += 8;
            (*index <= input.len()).then_some(())
        }
        2 => read_bytes(input, index).map(|_| ()),
        5 => {
            *index += 4;
            (*index <= input.len()).then_some(())
        }
        _ => None,
    }
}

/// Splits the file at the cursor: line is 1-based, column counts characters.
fn split_at_cursor(request: &TabRequest) -> (String, String) {
    let target_line = request.line.max(1);
    let mut offset = 0usize;
    let mut line = 1u32;
    for character in request.contents.chars() {
        if line >= target_line {
            break;
        }
        offset += character.len_utf8();
        if character == '\n' {
            line += 1;
        }
    }
    let rest = &request.contents[offset..];
    let mut cursor = offset;
    for (taken, character) in rest.chars().enumerate() {
        if taken >= request.column as usize || character == '\n' {
            break;
        }
        cursor += character.len_utf8();
    }
    (
        request.contents[..cursor].to_owned(),
        request.contents[cursor..].to_owned(),
    )
}

fn user_content(request: &TabRequest, prefix: &str, suffix: &str) -> String {
    let path = if request.path.is_empty() {
        "untitled"
    } else {
        request.path.as_str()
    };
    let language = if request.language.is_empty() {
        "unknown"
    } else {
        request.language.as_str()
    };
    format!(
        "File: {path}\nLanguage: {language}\n\n{}<CURSOR/>{}",
        tail(prefix, PREFIX_LIMIT),
        head(suffix, SUFFIX_LIMIT)
    )
}

fn tail(value: &str, limit: usize) -> &str {
    let total = value.chars().count();
    if total <= limit {
        return value;
    }
    let skip = total - limit;
    let index = value
        .char_indices()
        .nth(skip)
        .map_or(value.len(), |(index, _)| index);
    &value[index..]
}

fn head(value: &str, limit: usize) -> &str {
    value
        .char_indices()
        .nth(limit)
        .map_or(value, |(index, _)| &value[..index])
}

/// Drops markdown fences, the leading newline the model adds when the cursor
/// sits at the start of a line, and anything beyond the size a TAB suggestion
/// can usefully be. Indentation of the first line is preserved.
fn clean_suggestion(raw: &str, prefix: &str) -> String {
    let text = strip_fences(raw);
    // 光标已在行首时，模型多给的换行只会制造空行；行中则保留，用来另起一行。
    let text = if prefix.is_empty() || prefix.ends_with('\n') {
        text.trim_start_matches(['\n', '\r'])
    } else {
        text
    };
    let mut lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.truncate(SUGGESTION_LINE_LIMIT);
    let result = lines.join("\n");
    if result.chars().count() > SUGGESTION_CHAR_LIMIT {
        result
            .chars()
            .take(SUGGESTION_CHAR_LIMIT)
            .collect::<String>()
            .trim_end()
            .to_owned()
    } else {
        result
    }
}

fn strip_fences(value: &str) -> &str {
    let trimmed = value.trim_end();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let body = trimmed.trim_start_matches("```");
    let body = body.split_once('\n').map_or(body, |(_, rest)| rest);
    body.rsplit_once("```").map_or(body, |(body, _)| body)
}

fn encode_stream_cpp_response(text: &str, done: bool) -> Vec<u8> {
    let mut output = Vec::new();
    if !text.is_empty() {
        output.push(0x0a);
        put_varint(&mut output, text.len() as u64);
        output.extend_from_slice(text.as_bytes());
    }
    if done {
        output.push(0x20);
        output.push(1);
    }
    output
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(payload.len() + 5);
    output.push(0);
    output.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    output.extend_from_slice(payload);
    output
}

fn put_varint(output: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        output.push((value as u8) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_request(contents: &str, line: u32, column: u32) -> Vec<u8> {
        let mut cursor = vec![0x08];
        put_varint(&mut cursor, u64::from(line));
        cursor.push(0x10);
        put_varint(&mut cursor, u64::from(column));

        let mut file = vec![0x0a];
        put_varint(&mut file, 11);
        file.extend_from_slice(b"src/main.rs");
        file.push(0x12);
        put_varint(&mut file, contents.len() as u64);
        file.extend_from_slice(contents.as_bytes());
        file.push(0x1a);
        put_varint(&mut file, cursor.len() as u64);
        file.extend_from_slice(&cursor);
        file.extend_from_slice(&[0x2a, 4]);
        file.extend_from_slice(b"rust");

        let mut request = vec![0x0a];
        put_varint(&mut request, file.len() as u64);
        request.extend_from_slice(&file);
        request
    }

    #[test]
    fn parses_path_contents_language_and_cursor() {
        let buffer = encode_request("fn main() {}\n", 1, 3);
        let request = parse_stream_cpp(&buffer).unwrap();
        assert_eq!(request.path, "src/main.rs");
        assert_eq!(request.contents, "fn main() {}\n");
        assert_eq!(request.language, "rust");
        assert_eq!((request.line, request.column), (1, 3));
    }

    #[test]
    fn splits_at_the_cursor_counting_characters() {
        let request = TabRequest {
            contents: "let s = \"你好\";\n".into(),
            line: 1,
            column: 9,
            ..TabRequest::default()
        };
        let (prefix, suffix) = split_at_cursor(&request);
        assert_eq!(prefix, "let s = \"");
        assert_eq!(suffix, "你好\";\n");
    }

    #[test]
    fn splits_on_a_later_line() {
        let request = TabRequest {
            contents: "fn main() {\n    let x = 1;\n}\n".into(),
            line: 2,
            column: 4,
            ..TabRequest::default()
        };
        let (prefix, suffix) = split_at_cursor(&request);
        assert_eq!(prefix, "fn main() {\n    ");
        assert_eq!(suffix, "let x = 1;\n}\n");
    }

    #[test]
    fn response_carries_text_then_done_stream() {
        let payload = encode_stream_cpp_response("abc", true);
        assert_eq!(payload, b"\x0a\x03abc\x20\x01");
        let framed = frame(&payload);
        assert_eq!(&framed[..5], &[0, 0, 0, 0, payload.len() as u8]);
    }

    #[test]
    fn cleaning_strips_fences_and_drops_redundant_leading_newline() {
        let raw = "```rust\n\n    foo();\n```";
        assert_eq!(clean_suggestion(raw, "fn a() {\n"), "    foo();");
        assert_eq!(clean_suggestion("\n    foo();", "fn a() {"), "\n    foo();");
    }

    #[test]
    fn cleaning_caps_line_and_character_counts() {
        let raw = (0..40)
            .map(|index| format!("line{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let cleaned = clean_suggestion(&raw, "");
        assert_eq!(cleaned.lines().count(), SUGGESTION_LINE_LIMIT);
    }
}
