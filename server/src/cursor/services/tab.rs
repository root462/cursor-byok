//! Implements Cursor tab metadata services.
use axum::{
    body::Body,
    extract::{Extension, State},
    http::{Request, Response},
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
        if request.uri().path() == tab_local::STREAM_CPP_PATH {
            return tab_local::stream_cpp(&registry, request, &settings).await;
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
