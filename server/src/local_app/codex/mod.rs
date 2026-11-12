//! Codex Desktop local integration harness.
mod config;
mod paths;

use serde::Serialize;

use crate::{store::Store, Error, Result};

pub use paths::{get_codex_catalog_path, get_codex_config_dir, get_codex_config_path};

#[derive(Clone, Debug, Serialize)]
pub struct CodexHarnessStatus {
    pub installed: bool,
    pub config_path: String,
    pub catalog_path: String,
    pub configured_models: usize,
    pub settings_applied: bool,
    pub current_model: Option<String>,
}

#[derive(Clone)]
pub struct CodexHarness {
    store: Store,
}

impl CodexHarness {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn status(&self) -> Result<CodexHarnessStatus> {
        let models = self.store.client_models("codex").await?;
        let config_path = get_codex_config_path();
        let catalog_path = get_codex_catalog_path();
        let installed = config_path.parent().map(|p| p.exists()).unwrap_or(false);
        let settings_applied = config::is_codex_settings_applied();
        let current_model = models.first().map(|m| m.model_id.clone());

        Ok(CodexHarnessStatus {
            installed,
            config_path: config_path.to_string_lossy().to_string(),
            catalog_path: catalog_path.to_string_lossy().to_string(),
            configured_models: models.len(),
            settings_applied,
            current_model,
        })
    }

    async fn local_port(&self) -> u16 {
        self.store
            .port_settings()
            .await
            .map(|s| if s.service_port == 0 { 3000 } else { s.service_port })
            .unwrap_or(3000)
    }

    pub async fn set_enabled(
        &self,
        enabled: bool,
        terminate_process: bool,
    ) -> Result<CodexHarnessStatus> {
        let models = self.store.client_models("codex").await?;
        if enabled {
            if models.is_empty() {
                return Err(Error::Config(
                    "add at least one Codex model before applying settings".into(),
                ));
            }
            let port = self.local_port().await;
            config::apply_codex_settings(&models, port)?;
            // Codex 只在启动时读配置，开启接管后必须重启才能生效。
            // 重启在后台跑，接口立即返回，开关不会卡住。
            if terminate_process {
                crate::local_app::restart_codex();
            }
        } else {
            config::clear_codex_settings()?;
            // 关闭接管：退出 Codex 让它不再走本地代理，但不自动重新打开，
            // 由用户自己决定何时启动。退出同样在后台跑。
            if terminate_process {
                crate::local_app::terminate_codex_async();
            }
        }
        self.status().await
    }

    pub async fn sync_if_applied(&self) -> Result<()> {
        let models = self.store.client_models("codex").await?;
        if config::is_codex_settings_applied() {
            let port = self.local_port().await;
            config::apply_codex_settings(&models, port)?;
        }
        Ok(())
    }
}
