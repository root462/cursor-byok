//! Transparent proxy and protocol router for Codex Desktop.
//!
//! Accepts OpenAI Chat Completions (`/codex/v1/chat/completions` or `/codex/chat/completions`)
//! and Responses (`/codex/v1/responses` or `/codex/responses`),
//! matches the requested model against configured Codex models,
//! forwards to upstream through `ProviderRouter` (with automatic protocol and URL routing),
//! and streams back native events to Codex Desktop.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    api::byok::{
        output,
        protocol::{self, Protocol},
    },
    control::ControlService,
    model::ModelInvocation,
};

pub async fn chat(
    State(service): State<ControlService>,
    Json(body): Json<Value>,
) -> Response {
    handle_request(service, body, Protocol::Chat).await
}

pub async fn responses(
    State(service): State<ControlService>,
    Json(body): Json<Value>,
) -> Response {
    handle_request(service, body, Protocol::Responses).await
}

async fn handle_request(
    service: ControlService,
    body: Value,
    protocol: Protocol,
) -> Response {
    let model_name = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let models = match service.store().client_models("codex").await {
        Ok(models) => models,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": {
                        "message": err.to_string(),
                        "type": "server_error"
                    }
                })),
            )
                .into_response();
        }
    };

    if models.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "message": "No models configured for Codex Desktop in Cursor BYOK. Please add at least one model in settings.",
                    "type": "invalid_request_error"
                }
            })),
        )
            .into_response();
    }

    // Match by model_id, display_name, or model_hash; fallback to first model
    let target = models
        .iter()
        .find(|m| {
            m.model_id.eq_ignore_ascii_case(model_name)
                || m.display_name.eq_ignore_ascii_case(model_name)
                || m.model_hash == model_name
        })
        .unwrap_or(&models[0]);

    let parsed = match protocol::parse(protocol, &body) {
        Ok(parsed) => parsed,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": err.to_string(),
                        "type": "invalid_request_error"
                    }
                })),
            )
                .into_response();
        }
    };

    let id = format!("codex-desktop:{}", uuid::Uuid::new_v4());
    let mut request = parsed.request;
    // Set internal model_id to model_hash so ProviderRouter can locate it in client_model_configs
    request.model.model_id = target.model_hash.clone();
    target.configure(&mut request.model);

    let invocation = ModelInvocation {
        call_id: id.clone(),
        run_id: id.clone(),
        conversation_id: id.clone(),
        provider_call_index: 0,
        request,
    };

    let cancellation = CancellationToken::new();
    let stream = service.provider().stream(invocation, cancellation.clone());

    if parsed.stream {
        output::streamed(
            protocol,
            stream,
            cancellation,
            id,
            target.display_name.clone(),
        )
    } else {
        match output::complete(protocol, stream, &id, &target.display_name).await {
            Ok(response) => response.into_response(),
            Err(err) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": {
                        "message": err.to_string(),
                        "type": "bad_gateway"
                    }
                })),
            )
                .into_response(),
        }
    }
}

pub async fn list_models(
    State(service): State<ControlService>,
) -> Response {
    let models = match service.store().client_models("codex").await {
        Ok(models) => models,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": {
                        "message": err.to_string(),
                        "type": "server_error"
                    }
                })),
            )
                .into_response();
        }
    };

    let data: Vec<_> = models
        .into_iter()
        .map(|m| {
            json!({
                "id": m.model_id,
                "object": "model",
                "created": m.created_at_ms / 1000,
                "owned_by": "cursor-byok",
                "display_name": m.display_name
            })
        })
        .collect();

    Json(json!({
        "object": "list",
        "data": data
    }))
    .into_response()
}
