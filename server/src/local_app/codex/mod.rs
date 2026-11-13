//! Codex Desktop local integration harness.
mod config;
mod paths;

use serde::Serialize;

use crate::{store::Store, Error, Result};

use super::ServiceAddr;

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
    service_addr: ServiceAddr,
}

impl CodexHarness {
    pub fn new(store: Store, service_addr: ServiceAddr) -> Self {
        Self {
            store,
            service_addr,
        }
    }

    pub async fn status(&self) -> Result<CodexHarnessStatus> {
        let models = self.store.client_models("codex").await?;
        let config_path = get_codex_config_path();
        let catalog_path = get_codex_catalog_path();
        let installed = config_path.parent().map(|p| p.exists()).unwrap_or(false);
        let settings_applied = match self.service_addr.gateway_base() {
            Some(base) => config::is_codex_settings_applied(&base),
            None => false,
        };
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

    pub async fn set_enabled(
        &self,
        enabled: bool,
        terminate_process: bool,
    ) -> Result<CodexHarnessStatus> {
        if enabled {
            let models = self.store.client_models("codex").await?;
            if models.is_empty() {
                return Err(Error::Config(
                    "add at least one Codex model before applying settings".into(),
                ));
            }
            config::apply_codex_settings(&models, &self.ready_base()?)?;
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
        let Some(base) = self.service_addr.gateway_base() else {
            return Ok(());
        };
        // 接管中一律重写：模型增删改也要同步到 config.toml 和 catalog。
        if !config::is_codex_managed() {
            return Ok(());
        }
        let models = self.store.client_models("codex").await?;
        if models.is_empty() {
            return Ok(());
        }
        // 端口变化才算「旧配置已失效」。Codex 只在启动时读配置，正在跑的
        // 进程还拿着旧地址，必须重启一次才能连上新端口；纯模型改动不需要。
        let port_changed = !config::is_codex_settings_applied(&base);
        config::apply_codex_settings(&models, &base)?;
        if port_changed {
            crate::local_app::restart_codex();
        }
        Ok(())
    }

    /// 网关地址只有在服务绑定监听端口后才确定,不能假设默认端口。
    fn ready_base(&self) -> Result<String> {
        self.service_addr
            .gateway_base()
            .ok_or_else(|| Error::Config("local management service is not ready".into()))
    }
}
