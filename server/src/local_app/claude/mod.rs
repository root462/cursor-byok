//! Claude CLI local integration harness.
mod config;
mod paths;

use serde::Serialize;

use crate::{store::Store, Error, Result};

pub use paths::{get_claude_config_dir, get_claude_settings_path};

#[derive(Clone, Debug, Serialize)]
pub struct ClaudeHarnessStatus {
    pub installed: bool,
    pub config_path: String,
    pub configured_models: usize,
    pub settings_applied: bool,
    pub current_model: Option<String>,
}

#[derive(Clone)]
pub struct ClaudeHarness {
    store: Store,
}

impl ClaudeHarness {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn status(&self) -> Result<ClaudeHarnessStatus> {
        let models = self.store.client_models("claude").await?;
        let config_path = get_claude_settings_path();
        let installed = config_path.parent().map(|p| p.exists()).unwrap_or(false);
        let settings_applied = config::is_claude_settings_applied(&models);
        let current_model = models.first().map(|m| m.model_id.clone());

        Ok(ClaudeHarnessStatus {
            installed,
            config_path: config_path.to_string_lossy().to_string(),
            configured_models: models.len(),
            settings_applied,
            current_model,
        })
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<ClaudeHarnessStatus> {
        let models = self.store.client_models("claude").await?;
        if enabled {
            if models.is_empty() {
                return Err(Error::Config(
                    "add at least one Claude model before applying settings".into(),
                ));
            }
            config::apply_claude_settings(&models)?;
        } else {
            config::clear_claude_settings()?;
        }
        self.status().await
    }

    pub async fn sync_if_applied(&self) -> Result<()> {
        let models = self.store.client_models("claude").await?;
        if config::is_claude_settings_applied(&models) {
            config::apply_claude_settings(&models)?;
        }
        Ok(())
    }
}
