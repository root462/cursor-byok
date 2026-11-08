//! Implements local application control endpoints.
use axum::{extract::State, Json};

use crate::{
    local_app::{detect_cursor_app, CursorAppInfo, CursorHarnessStatus, SetEnabled},
    Result,
};

use super::ControlService;

pub async fn status(State(service): State<ControlService>) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().status().await?))
}

/// Reports the Cursor desktop build installed on this machine.
pub async fn app_info() -> Json<CursorAppInfo> {
    Json(detect_cursor_app().await)
}

pub async fn runtime_status(
    State(service): State<ControlService>,
) -> Json<crate::cursor::services::runtime_compatibility::RuntimeCompatibilityStatus> {
    Json(service.runtime_compatibility().status())
}

pub async fn initialize_ca(
    State(service): State<ControlService>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().initialize_ca().await?))
}

pub async fn set_enabled(
    State(service): State<ControlService>,
    Json(input): Json<SetEnabled>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(
        service.cursor_harness().set_enabled(input.enabled).await?,
    ))
}
