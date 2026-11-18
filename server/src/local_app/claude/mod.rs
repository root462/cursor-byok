//! Claude CLI local integration harness.
mod config;
mod paths;

use serde::Serialize;

use crate::{store::Store, Error, Result};

use super::ServiceAddr;

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
    service_addr: ServiceAddr,
}

impl ClaudeHarness {
    pub fn new(store: Store, service_addr: ServiceAddr) -> Self {
        Self {
            store,
            service_addr,
        }
    }

    pub async fn status(&self) -> Result<ClaudeHarnessStatus> {
        let models = self.store.client_models("claude").await?;
        let config_path = get_claude_settings_path();
        let installed = config_path.parent().map(|p| p.exists()).unwrap_or(false);
        let settings_applied = match self.service_addr.gateway_base() {
            Some(base) => config::is_claude_settings_applied(&models, &base),
            None => false,
        };
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
        if enabled {
            let models = self.store.client_models("claude").await?;
            if models.is_empty() {
                return Err(Error::Config(
                    "add at least one Claude model before applying settings".into(),
                ));
            }
            config::apply_claude_settings(&models, &self.ready_base()?)?;
        } else {
            config::clear_claude_settings()?;
        }
        self.status().await
    }

    pub async fn sync_if_applied(&self) -> Result<()> {
        let Some(base) = self.service_addr.gateway_base() else {
            return Ok(());
        };
        // 接管中一律重写：模型增删改和端口变化都要落到 settings.json。
        // 判断「是否接管」必须与端口无关，否则改过端口后会因为地址对不上而永不改写，
        // Claude CLI 就会一直连旧端口。CLI 每次启动才读这个文件，重启后即生效。
        if !config::is_claude_managed() {
            return Ok(());
        }
        let models = self.store.client_models("claude").await?;
        if models.is_empty() {
            return Ok(());
        }
        config::apply_claude_settings(&models, &base)
    }

    /// 网关地址只有在服务绑定监听端口后才确定,不能假设默认端口。
    fn ready_base(&self) -> Result<String> {
        self.service_addr
            .gateway_base()
            .ok_or_else(|| Error::Config("local management service is not ready".into()))
    }
}
