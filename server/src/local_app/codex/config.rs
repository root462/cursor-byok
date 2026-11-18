//! Codex config.toml and model catalog reader and patcher.
use std::{fs, path::Path};

use serde_json::json;
use toml_edit::{table, value, DocumentMut, Item};

use crate::{model::ModelConfig, Error, Result};

use super::paths::{get_codex_catalog_path, get_codex_config_dir, get_codex_config_path};

const CATALOG_FILENAME: &str = "cursor-byok-model-catalog.json";
/// 写进 `config.toml` 的本地占位 token，同时作为「配置由本应用接管」的标记。
const MANAGED_TOKEN: &str = "cursor-byok-local";

/// 配置是否仍由本应用接管。与端口无关：用户改了服务端口后，config.toml 里的
/// 旧地址依然算「接管中」，只是需要按新端口重写。用本地 bearer token 作为管理签名。
pub fn is_codex_managed() -> bool {
    read_config_text()
        .map(|text| text.contains(MANAGED_TOKEN) && text.contains("model_provider"))
        .unwrap_or(false)
}

/// 接管中，且写入的网关地址就是当前实际监听端口。
pub fn is_codex_settings_applied(gateway_base: &str) -> bool {
    let catalog_path = get_codex_catalog_path();
    let Some(text) = read_config_text() else {
        return false;
    };
    if !catalog_path.exists() || !is_codex_managed() {
        return false;
    }
    text.contains(&format!("{gateway_base}/codex"))
}

fn read_config_text() -> Option<String> {
    fs::read_to_string(get_codex_config_path()).ok()
}

pub(crate) fn patch_codex_config(
    doc: &mut DocumentMut,
    catalog_path: &Path,
    models: &[ModelConfig],
    gateway_base: &str,
) {
    doc["model_provider"] = value("custom");
    doc["model_catalog_json"] = value(catalog_path.to_string_lossy().as_ref());

    if let Some(first) = models.first() {
        doc["model"] = value(first.model_id.as_str());
        let effort = first
            .reasoning_effort
            .as_deref()
            .or(first.anthropic_thinking_effort.as_deref());
        if let Some(effort) = effort {
            doc["model_reasoning_effort"] = value(effort);
        }

        // Ensure [model_providers]
        if !doc.contains_key("model_providers") || !doc["model_providers"].is_table() {
            doc["model_providers"] = table();
        }
        let providers_item = doc.get_mut("model_providers").unwrap();
        let providers_table = providers_item.as_table_mut().unwrap();

        // Ensure [model_providers.custom]
        if !providers_table.contains_key("custom") || !providers_table["custom"].is_table() {
            providers_table.insert("custom", table());
        }
        let custom_table = providers_table
            .get_mut("custom")
            .unwrap()
            .as_table_mut()
            .unwrap();

        // Route all models through Cursor BYOK local gateway.
        // This enables simultaneous support for any combination of providers (DeepSeek, GLM, Claude, etc.)
        let base_url = format!("{gateway_base}/codex");
        custom_table["name"] = value("Cursor BYOK");
        custom_table["base_url"] = value(base_url.as_str());
        custom_table["wire_api"] = value("responses");
        custom_table["experimental_bearer_token"] = value(MANAGED_TOKEN);
    }
}

pub(crate) fn unpatch_codex_config(doc: &mut DocumentMut, catalog_path: &Path) {
    if doc
        .get("model_provider")
        .and_then(Item::as_str)
        .map(|v| v == "custom")
        .unwrap_or(false)
    {
        doc.remove("model_provider");
    }
    let catalog_str = catalog_path.to_string_lossy();
    if doc
        .get("model_catalog_json")
        .and_then(Item::as_str)
        .map(|v| {
            v == CATALOG_FILENAME || v == catalog_str.as_ref() || v.ends_with(CATALOG_FILENAME)
        })
        .unwrap_or(false)
    {
        doc.remove("model_catalog_json");
    }
    doc.remove("model_reasoning_effort");
    if let Some(providers) = doc.get_mut("model_providers").and_then(Item::as_table_mut) {
        providers.remove("custom");
    }
}

fn build_codex_catalog_entry(m: &ModelConfig, index: usize) -> serde_json::Value {
    let context_window = m.context_window_tokens.unwrap_or(128_000);
    let description = if m.tooltip_data.trim().is_empty() {
        m.display_name.clone()
    } else {
        m.tooltip_data.clone()
    };
    let effort = m
        .reasoning_effort
        .as_deref()
        .or(m.anthropic_thinking_effort.as_deref());
    let default_level = effort.unwrap_or("none");

    json!({
        "slug": m.model_id,
        "display_name": m.display_name,
        "description": description,
        "base_instructions": "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
        "default_reasoning_level": default_level,
        "supported_reasoning_levels": [
            { "effort": "none", "description": "Disable Thinking" },
            { "effort": "low", "description": "Fast responses with lighter reasoning" },
            { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" },
            { "effort": "high", "description": "Greater reasoning depth for complex problems" },
            { "effort": "max", "description": "Maximum reasoning depth for the hardest problems" }
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 1000 + index,
        "supports_reasoning_summaries": true,
        "default_reasoning_summary": "none",
        "support_verbosity": false,
        "truncation_policy": {
            "mode": "bytes",
            "limit": 10000
        },
        "supports_parallel_tool_calls": true,
        "supports_image_detail_original": false,
        "context_window": context_window,
        "max_context_window": context_window,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text", "image"],
        "supports_search_tool": false
    })
}

pub fn apply_codex_settings(models: &[ModelConfig], gateway_base: &str) -> Result<()> {
    let config_dir = get_codex_config_dir();
    fs::create_dir_all(&config_dir)
        .map_err(|e| Error::Store(format!("failed to create codex config dir: {e}")))?;

    // 1. Generate model catalog JSON
    let catalog_path = get_codex_catalog_path();
    let entries: Vec<_> = models
        .iter()
        .enumerate()
        .map(|(index, m)| build_codex_catalog_entry(m, index))
        .collect();

    let catalog_json = json!({ "models": entries });
    let catalog_str = serde_json::to_string_pretty(&catalog_json)
        .map_err(|e| Error::Store(format!("failed to serialize codex catalog: {e}")))?;
    fs::write(&catalog_path, catalog_str)
        .map_err(|e| Error::Store(format!("failed to write codex catalog: {e}")))?;

    // 2. Patch config.toml
    let config_path = get_codex_config_path();
    let mut doc: DocumentMut = if config_path.exists() {
        let text = fs::read_to_string(&config_path)
            .map_err(|e| Error::Store(format!("failed to read codex config.toml: {e}")))?;
        text.parse::<DocumentMut>().unwrap_or_default()
    } else {
        DocumentMut::new()
    };

    patch_codex_config(&mut doc, &catalog_path, models, gateway_base);

    fs::write(&config_path, doc.to_string())
        .map_err(|e| Error::Store(format!("failed to write codex config.toml: {e}")))?;
    Ok(())
}

pub fn clear_codex_settings() -> Result<()> {
    let config_path = get_codex_config_path();
    let catalog_path = get_codex_catalog_path();
    if config_path.exists() {
        if let Ok(text) = fs::read_to_string(&config_path) {
            if let Ok(mut doc) = text.parse::<DocumentMut>() {
                unpatch_codex_config(&mut doc, &catalog_path);
                let _ = fs::write(&config_path, doc.to_string());
            }
        }
    }

    if catalog_path.exists() {
        let _ = fs::remove_file(catalog_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn sample_model() -> ModelConfig {
        ModelConfig {
            model_hash: "test-hash".into(),
            sort_order: 0,
            display_name: "DeepSeek".into(),
            group_name: None,
            model_type: crate::model::ModelType::OpenAi,
            base_url: "https://api.deepseek.com".into(),
            use_full_url: false,
            api_key: "sk-test".into(),
            tooltip_data: String::new(),
            model_id: "deepseek-chat".into(),
            reasoning_effort: None,
            openai_endpoint: crate::model::OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: Some(64_000),
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn patch_codex_config_writes_absolute_catalog_path() {
        let mut doc = DocumentMut::new();
        let catalog_path = PathBuf::from("/Users/alice/.codex/cursor-byok-model-catalog.json");
        let model = sample_model();

        patch_codex_config(&mut doc, &catalog_path, &[model], "http://127.0.0.1:3000");

        assert_eq!(
            doc["model_catalog_json"].as_str(),
            Some("/Users/alice/.codex/cursor-byok-model-catalog.json")
        );
        assert_eq!(doc["model_provider"].as_str(), Some("custom"));
        assert_eq!(doc["model"].as_str(), Some("deepseek-chat"));
        assert_eq!(
            doc["model_providers"]["custom"]["name"].as_str(),
            Some("Cursor BYOK")
        );
        assert_eq!(
            doc["model_providers"]["custom"]["base_url"].as_str(),
            Some("http://127.0.0.1:3000/codex")
        );
        assert_eq!(
            doc["model_providers"]["custom"]["wire_api"].as_str(),
            Some("responses")
        );
        assert_eq!(
            doc["model_providers"]["custom"]["experimental_bearer_token"].as_str(),
            Some("cursor-byok-local")
        );

        unpatch_codex_config(&mut doc, &catalog_path);
        assert!(!doc.contains_key("model_catalog_json"));
        assert!(!doc.contains_key("model_provider"));
        assert!(doc.get("model_providers").and_then(|p| p.get("custom")).is_none());
    }

    #[test]
    fn base_url_follows_the_configured_service_port() {
        let mut doc = DocumentMut::new();
        let catalog_path = PathBuf::from("/Users/alice/.codex/cursor-byok-model-catalog.json");

        patch_codex_config(
            &mut doc,
            &catalog_path,
            &[sample_model()],
            "http://127.0.0.1:4000",
        );

        assert_eq!(
            doc["model_providers"]["custom"]["base_url"].as_str(),
            Some("http://127.0.0.1:4000/codex")
        );
    }

    #[test]
    fn unpatch_codex_config_cleans_legacy_relative_catalog_path() {
        let mut doc = DocumentMut::new();
        doc["model_catalog_json"] = value(CATALOG_FILENAME);
        doc["model_provider"] = value("custom");

        let catalog_path = PathBuf::from("/Users/alice/.codex/cursor-byok-model-catalog.json");
        unpatch_codex_config(&mut doc, &catalog_path);

        assert!(!doc.contains_key("model_catalog_json"));
        assert!(!doc.contains_key("model_provider"));
    }
}
