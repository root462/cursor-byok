//! Transparent proxy and protocol translation router for Claude Code CLI.
//!
//! Accepts Anthropic Messages protocol (`/claude/v1/messages`),
//! matches the requested model against configured Claude models,
//! forwards to upstream (translating to OpenAI Chat Completions or Responses if needed),
//! and streams back native Anthropic Messages SSE events to Claude Code.

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

pub async fn messages(
    State(service): State<ControlService>,
    Json(mut body): Json<Value>,
) -> Response {
    strip_billing_header(&mut body);
    let model_name = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let models = match service.store().client_models("claude").await {
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
                    "message": "No models configured for Claude CLI in Cursor BYOK. Please add at least one model in settings.",
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

    let parsed = match protocol::parse(Protocol::Messages, &body) {
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

    let id = format!("claude-code:{}", uuid::Uuid::new_v4());
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
            Protocol::Messages,
            stream,
            cancellation,
            id,
            target.display_name.clone(),
        )
    } else {
        match output::complete(Protocol::Messages, stream, &id, &target.display_name).await {
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

/// Drops Claude Code's `x-anthropic-billing-header` line from the system prompt.
///
/// Claude Code prepends it for Anthropic's own accounting. Gateways that run
/// upstream content filters treat the line as an injected protocol header and
/// reject the whole request with `content rejected by upstream`, so the request
/// never reaches the model. The line carries no meaning for other providers.
fn strip_billing_header(body: &mut Value) {
    const MARKER: &str = "x-anthropic-billing-header";
    fn strip(text: &str) -> Option<String> {
        if !text.starts_with(MARKER) {
            return None;
        }
        Some(
            text.split_once('\n')
                .map_or_else(String::new, |(_, rest)| rest.to_owned()),
        )
    }
    match body.get_mut("system") {
        Some(Value::String(text)) => {
            if let Some(rest) = strip(text) {
                *text = rest;
            }
        }
        Some(Value::Array(parts)) => {
            if let Some(Value::String(text)) = parts.first_mut().and_then(|part| part.get_mut("text"))
            {
                if let Some(rest) = strip(text) {
                    *text = rest;
                }
            }
        }
        _ => {}
    }
}

pub async fn count_tokens(Json(body): Json<Value>) -> Response {
    let parsed = match protocol::parse(Protocol::Messages, &body) {
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
    let input_tokens =
        crate::model::estimate_context_tokens(&parsed.request.prompt, &parsed.request.history);
    Json(json!({ "input_tokens": input_tokens })).into_response()
}

pub async fn list_models(
    State(service): State<ControlService>,
) -> Response {
    let models = match service.store().client_models("claude").await {
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

    let mut data: Vec<Value> = Vec::new();
    for m in &models {
        data.push(json!({
            "id": m.model_id,
            "type": "model",
            "display_name": m.display_name,
            "created_at": "2024-01-01T00:00:00Z"
        }));
        if !m.display_name.eq_ignore_ascii_case(&m.model_id) {
            data.push(json!({
                "id": m.display_name,
                "type": "model",
                "display_name": m.display_name,
                "created_at": "2024-01-01T00:00:00Z"
            }));
        }
    }

    Json(json!({
        "data": data,
        "object": "list"
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn billing_header_is_stripped_from_string_and_block_system_prompts() {
        let header = "x-anthropic-billing-header: cc_version=2.1.322.3b5; cc_entrypoint=cli;\n";
        let mut string_form = json!({ "system": format!("{header}You are Claude Code.") });
        strip_billing_header(&mut string_form);
        assert_eq!(string_form["system"], "You are Claude Code.");

        let mut block_form = json!({ "system": [{"type": "text", "text": format!("{header}You are Claude Code.")}] });
        strip_billing_header(&mut block_form);
        assert_eq!(block_form["system"][0]["text"], "You are Claude Code.");
    }

    #[test]
    fn prompts_without_the_header_are_untouched() {
        let mut body = json!({ "system": "You are Claude Code." });
        strip_billing_header(&mut body);
        assert_eq!(body["system"], "You are Claude Code.");

        let mut header_only = json!({ "system": "x-anthropic-billing-header: cc_version=1;" });
        strip_billing_header(&mut header_only);
        assert_eq!(header_only["system"], "");
    }
}
