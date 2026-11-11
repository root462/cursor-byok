//! Implements Cursor tab metadata services.
use axum::{
    body::Body,
    extract::{Extension, State},
    http::{header, HeaderValue, Request, Response, StatusCode},
    routing::post,
    Router,
};

use crate::{
    api::cursor::proxy, cursor::services::tab_local, cursor::transport::TransportRegistry, Result,
};

pub const TAB_PATHS: [&str; 16] = [
    "/aiserver.v1.AiService/StreamCpp",
    "/aiserver.v1.AiService/StreamNextCursorPrediction",
    "/aiserver.v1.AiService/GetCppEditClassification",
    "/aiserver.v1.AiService/RefreshTabContext",
    "/aiserver.v1.AiService/CppConfig",
    "/aiserver.v1.AiService/CppEditHistoryStatus",
    "/aiserver.v1.AiService/CppAppend",
    "/aiserver.v1.AiService/CppEditHistoryAppend",
    "/aiserver.v1.AiService/ReportAiCodeChangeMetrics",
    "/aiserver.v1.AiService/WriteGitBranchName",
    "/aiserver.v1.CppService/AvailableModels",
    "/aiserver.v1.CppService/RecordCppFate",
    "/aiserver.v1.FileSyncService/FSSyncFile",
    "/aiserver.v1.FileSyncService/FSIsEnabledForUser",
    "/aiserver.v1.FileSyncService/FSConfig",
    "/aiserver.v1.FileSyncService/FSUploadFile",
];

pub fn is_tab_path(path: &str) -> bool {
    TAB_PATHS.contains(&path)
}

pub fn router() -> Router<TransportRegistry> {
    TAB_PATHS.into_iter().fold(Router::new(), |router, path| {
        router.route(path, post(forward))
    })
}

async fn forward(
    State(registry): State<TransportRegistry>,
    Extension(upstream): Extension<proxy::CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let settings = registry.store().tab_settings().await?;
    if settings.is_local() {
        let path = request.uri().path();
        if path == tab_local::STREAM_CPP_PATH {
            return tab_local::stream_cpp(&registry, request, &settings).await;
        }
        if path == "/aiserver.v1.FileSyncService/FSIsEnabledForUser" {
            return fs_is_enabled_for_user(request);
        }
        // 本地模式只接管补全本身：光标预测、配置、编辑历史仍走官方。
        return proxy::forward(Extension(upstream), request).await;
    }
    match settings.service_url() {
        Some(url) => {
            let service = proxy::TabServiceAuth {
                url,
                api_key: &settings.api_key,
                model: &settings.model,
            };
            proxy::forward_to_service(&upstream, request, service).await
        }
        None => proxy::forward(Extension(upstream), request).await,
    }
}

/// Disables Cursor's remote FileSync when running local TAB.
///
/// When FileSync is enabled, Cursor omits `contents` in `StreamCppRequest`
/// assuming the server has hydrated the document via diff sync. Answering
/// `enabled: false` forces Cursor to always embed the full in-memory buffer.
fn fs_is_enabled_for_user(request: Request<Body>) -> Result<Response<Body>> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/proto");

    let is_json = content_type.contains("json");
    let is_connect = content_type.starts_with("application/connect");

    let (bytes, res_ct) = if is_json {
        let json = r#"{"enabled":false}"#;
        if is_connect {
            let mut buf = Vec::with_capacity(5 + json.len());
            buf.push(0);
            buf.extend_from_slice(&(json.len() as u32).to_be_bytes());
            buf.extend_from_slice(json.as_bytes());
            (buf, "application/connect+json")
        } else {
            (json.as_bytes().to_vec(), "application/json")
        }
    } else {
        let proto = Vec::<u8>::new();
        if is_connect {
            let mut buf = vec![0, 0, 0, 0, 0];
            buf.extend_from_slice(&proto);
            (buf, "application/connect+proto")
        } else {
            (proto, "application/proto")
        }
    };

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(res_ct));
    if request.headers().contains_key("connect-protocol-version") {
        response
            .headers_mut()
            .insert("connect-protocol-version", HeaderValue::from_static("1"));
    }
    tracing::info!("intercepted FSIsEnabledForUser: returned enabled=false to force full contents in StreamCpp");
    Ok(response)
}
