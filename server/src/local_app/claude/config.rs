//! Claude Code settings.json reader, patcher, and generator.
use std::fs;

use serde_json::{json, Value};

use crate::{model::ModelConfig, Error, Result};

use super::paths::get_claude_settings_path;

/// 写进 `settings.json` 的本地占位 token，同时作为「配置由本应用接管」的标记。
const LOCAL_TOKEN: &str = "cursor-byok-local";

/// 配置是否仍由本应用接管。
///
/// 与端口无关：用户改了服务端口后，settings.json 里的旧地址依然算「接管中」，
/// 只是需要按新端口重写。用本地 token 作为管理签名。
pub fn is_claude_managed() -> bool {
    let Some(value) = read_settings() else {
        return false;
    };
    value
        .get("env")
        .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
        .and_then(Value::as_str)
        .is_some_and(|token| token == LOCAL_TOKEN)
}

/// 接管中，且写入的网关地址就是当前实际监听端口。
pub fn is_claude_settings_applied(models: &[ModelConfig], gateway_base: &str) -> bool {
    if models.is_empty() {
        return false;
    }
    let Some(value) = read_settings() else {
        return false;
    };
    is_claude_managed() && base_url_matches(&value, gateway_base)
}

fn base_url_matches(value: &Value, gateway_base: &str) -> bool {
    let expected = format!("{gateway_base}/claude");
    value
        .get("env")
        .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
        .and_then(Value::as_str)
        .map(|url| url.trim_end_matches('/') == expected)
        .unwrap_or(false)
}

fn read_settings() -> Option<Value> {
    let path = get_claude_settings_path();
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn build_claude_settings(
    existing: &Value,
    models: &[ModelConfig],
    gateway_base: &str,
) -> Value {
    let mut root: Value = existing.clone();
    if !root.is_object() {
        root = json!({});
    }

    if let Some(first) = models.first() {
        let root_obj = root.as_object_mut().unwrap();
        root_obj.insert("primaryModel".into(), json!(first.model_id));
        root_obj.insert("model".into(), json!(first.model_id));

        // Generate top-level modelPicker for Claude Code (v2.1.243+)
        // This makes Claude CLI's `/model` menu display user-configured display names and options.
        let picker_options: Vec<Value> = models
            .iter()
            .map(|m| {
                let type_label = match m.model_type {
                    crate::model::ModelType::OpenAi => "OpenAI",
                    crate::model::ModelType::Anthropic => "Anthropic",
                };
                let ctx_label = m
                    .context_window_tokens
                    .map(|t| format!(" · {}K", t / 1000))
                    .unwrap_or_default();
                let desc = if !m.tooltip_data.is_empty() {
                    format!("{type_label} · {}{ctx_label}", m.tooltip_data)
                } else {
                    format!("{type_label} · {}{ctx_label}", m.model_id)
                };
                json!({
                    "model": m.model_id,
                    "label": m.display_name,
                    "description": desc,
                })
            })
            .collect();

        root_obj.insert(
            "modelPicker".into(),
            json!({
                "replaceBuiltInOptions": true,
                "options": picker_options,
            }),
        );

        // Find a suitable secondary small fast model if available
        let small_model = models
            .iter()
            .skip(1)
            .find(|m| {
                let id = m.model_id.to_lowercase();
                id.contains("haiku")
                    || id.contains("mini")
                    || id.contains("flash")
                    || id.contains("small")
            })
            .or_else(|| models.get(1));
        let small_model_id = small_model.map(|m| m.model_id.as_str()).unwrap_or(&first.model_id);
        let small_model_name = small_model.map(|m| m.display_name.as_str()).unwrap_or(&first.display_name);
        root_obj.insert("smallFastModel".into(), json!(small_model_id));

        if !root_obj.contains_key("env") || !root_obj["env"].is_object() {
            root_obj.insert("env".into(), json!({}));
        }
        let env_obj = root_obj.get_mut("env").unwrap().as_object_mut().unwrap();

        // Always route through the local transparent proxy at {gateway_base}/claude.
        // This ensures OpenAI-protocol models (e.g. DeepSeek) are converted to Anthropic Messages,
        // multi-model switching in `/model` routes to respective upstream providers,
        // and calls are logged in the Cursor BYOK dashboard.
        env_obj.insert(
            "ANTHROPIC_BASE_URL".into(),
            json!(format!("{gateway_base}/claude")),
        );
        env_obj.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(LOCAL_TOKEN));

        // Do not pin ANTHROPIC_MODEL in env, otherwise Claude Code prints:
        // "ANTHROPIC_MODEL is set to ... - new sessions use that while it is set"
        // and overrides user's /model interactive selection.
        env_obj.remove("ANTHROPIC_MODEL");
        env_obj.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".into(),
            json!(first.model_id),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME".into(),
            json!(first.display_name),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION".into(),
            json!(first.display_name),
        );

        env_obj.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), json!(first.model_id));
        env_obj.insert(
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".into(),
            json!(first.display_name),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION".into(),
            json!(first.display_name),
        );

        env_obj.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL".into(),
            json!(small_model_id),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME".into(),
            json!(small_model_name),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION".into(),
            json!(small_model_name),
        );
        env_obj.insert("CLAUDE_CODE_SUBAGENT_MODEL".into(), json!(first.model_id));

        if let Some(ctx) = first.context_window_tokens {
            env_obj.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), json!(ctx.to_string()));
        } else {
            env_obj.remove("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
        }

        let max_output = first.anthropic_max_tokens.or(first.max_completion_tokens);
        if let Some(out) = max_output {
            env_obj.insert("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), json!(out.to_string()));
        } else {
            env_obj.remove("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
        }

        if let Some(budget) = first.thinking_budget_tokens {
            env_obj.insert("MAX_THINKING_TOKENS".into(), json!(budget.to_string()));
        } else {
            env_obj.remove("MAX_THINKING_TOKENS");
        }

        if first.custom_headers_enabled && first.custom_headers.is_object() && !first.custom_headers.as_object().unwrap().is_empty() {
            if let Ok(headers_str) = serde_json::to_string(&first.custom_headers) {
                env_obj.insert("ANTHROPIC_CUSTOM_HEADERS".into(), json!(headers_str));
            }
        } else {
            env_obj.remove("ANTHROPIC_CUSTOM_HEADERS");
        }
    }
    root
}

pub fn strip_claude_settings(existing: &Value) -> Value {
    let mut root = existing.clone();
    if let Some(obj) = root.as_object_mut() {
        obj.remove("primaryModel");
        obj.remove("model");
        obj.remove("smallFastModel");
        obj.remove("modelPicker");
        if let Some(env) = obj.get_mut("env").and_then(Value::as_object_mut) {
            env.remove("ANTHROPIC_BASE_URL");
            env.remove("ANTHROPIC_AUTH_TOKEN");
            env.remove("ANTHROPIC_MODEL");
            env.remove("ANTHROPIC_DEFAULT_SONNET_MODEL");
            env.remove("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME");
            env.remove("ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION");
            env.remove("ANTHROPIC_DEFAULT_OPUS_MODEL");
            env.remove("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME");
            env.remove("ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION");
            env.remove("ANTHROPIC_DEFAULT_HAIKU_MODEL");
            env.remove("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME");
            env.remove("ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION");
            env.remove("CLAUDE_CODE_SUBAGENT_MODEL");
            env.remove("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
            env.remove("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
            env.remove("MAX_THINKING_TOKENS");
            env.remove("ANTHROPIC_CUSTOM_HEADERS");
        }
    }
    root
}

pub fn apply_claude_settings(models: &[ModelConfig], gateway_base: &str) -> Result<()> {
    let path = get_claude_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| Error::Store(format!("failed to create claude config dir: {e}")))?;
    }

    let root: Value = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| Error::Store(format!("failed to read claude settings: {e}")))?;
        serde_json::from_str(&content).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    let next = build_claude_settings(&root, models, gateway_base);
    let serialized = serde_json::to_string_pretty(&next)
        .map_err(|e| Error::Store(format!("failed to serialize claude settings: {e}")))?;
    fs::write(&path, serialized)
        .map_err(|e| Error::Store(format!("failed to write claude settings: {e}")))?;
    Ok(())
}

pub fn clear_claude_settings() -> Result<()> {
    let path = get_claude_settings_path();
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| Error::Store(format!("failed to read claude settings: {e}")))?;
    let root: Value = serde_json::from_str(&content).unwrap_or_else(|_| json!({}));
    let next = strip_claude_settings(&root);
    let serialized = serde_json::to_string_pretty(&next)
        .map_err(|e| Error::Store(format!("failed to serialize claude settings: {e}")))?;
    fs::write(&path, serialized)
        .map_err(|e| Error::Store(format!("failed to write claude settings: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelConfig, ModelType};

    fn test_model(id: &str, display: &str, mtype: ModelType) -> ModelConfig {
        ModelConfig {
            model_hash: format!("hash-{id}"),
            model_id: id.into(),
            display_name: display.into(),
            group_name: None,
            model_type: mtype,
            base_url: "https://api.openai.com/v1".into(),
            use_full_url: false,
            api_key: "sk-test".into(),
            sort_order: 1,
            context_window_tokens: Some(200_000),
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            thinking_budget_tokens: None,
            reasoning_effort: None,
            openai_endpoint: String::new(),
            anthropic_thinking_effort: None,
            custom_headers_enabled: false,
            custom_headers: Value::Object(Default::default()),
            openai_extra_params_enabled: false,
            openai_extra_params: Value::Object(Default::default()),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: Value::Object(Default::default()),
            tooltip_data: String::new(),
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn test_build_claude_settings_includes_model_picker_and_proxy() {
        let models = vec![
            test_model("claude-3-7-sonnet", "Claude 3.7 Sonnet", ModelType::Anthropic),
            test_model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", ModelType::OpenAi),
        ];

        let result = build_claude_settings(
            &json!({ "theme": "dark" }),
            &models,
            "http://127.0.0.1:3000",
        );

        assert_eq!(result["theme"], "dark");
        assert_eq!(result["primaryModel"], "claude-3-7-sonnet");
        assert_eq!(result["model"], "claude-3-7-sonnet");

        let picker = &result["modelPicker"];
        assert_eq!(picker["replaceBuiltInOptions"], true);
        let options = picker["options"].as_array().expect("options array");
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["model"], "claude-3-7-sonnet");
        assert_eq!(options[0]["label"], "Claude 3.7 Sonnet");
        assert_eq!(options[1]["model"], "deepseek-v4.1-flash");
        assert_eq!(options[1]["label"], "DeepSeek V4.1 Flash");

        let env = &result["env"];
        assert_eq!(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:3000/claude");
        assert_eq!(env["ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"], "Claude 3.7 Sonnet");
        assert!(env.get("ANTHROPIC_MODEL").is_none());

        let stripped = strip_claude_settings(&result);
        assert_eq!(stripped["theme"], "dark");
        assert!(stripped.get("modelPicker").is_none());
        assert!(stripped.get("primaryModel").is_none());
        assert!(stripped["env"].get("ANTHROPIC_BASE_URL").is_none());
    }

    #[test]
    fn base_url_follows_the_configured_service_port() {
        let models = vec![test_model("deepseek-chat", "DeepSeek", ModelType::OpenAi)];

        let result = build_claude_settings(&json!({}), &models, "http://127.0.0.1:4000");

        assert_eq!(
            result["env"]["ANTHROPIC_BASE_URL"],
            "http://127.0.0.1:4000/claude"
        );
        assert!(base_url_matches(&result, "http://127.0.0.1:4000"));
        assert!(!base_url_matches(&result, "http://127.0.0.1:3000"));
    }
}
