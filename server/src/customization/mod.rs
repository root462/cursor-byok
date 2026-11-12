//! 管理 Claude CLI 与 Codex Desktop 的提示词与 Skill。
//!
//! 两个客户端都从各自的配置目录读取一个全局提示词文件，并从 `skills/` 下的
//! 子目录发现 Skill。本模块把这两类文件收敛成「数据库记录 + 投影到磁盘」，
//! 让用户能在应用内编写、启用、启停，而不必手改文件。
//!
//! 所有磁盘路径由 [`Paths`] 统一给出：生产环境读真实主目录，测试可以指向
//! 临时目录，因此服务层本身不直接触达用户文件系统。

mod prompts;
mod skills;

pub use prompts::PromptService;
pub use skills::{SkillInstallInput, SkillService};

use std::path::{Path, PathBuf};

use crate::{model::CustomizationClient, Error, Result};

/// 一次请求要用到的全部磁盘根目录。
#[derive(Clone, Debug)]
pub struct Paths {
    home: PathBuf,
    data_dir: PathBuf,
}

impl Paths {
    /// 真实用户环境：主目录 + 应用数据目录。
    pub fn system() -> Result<Self> {
        Ok(Self {
            home: dirs::home_dir().ok_or_else(|| Error::Config("cannot resolve home".into()))?,
            data_dir: crate::config::managed_data_dir()?,
        })
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    #[cfg(test)]
    pub fn rooted(home: PathBuf, data_dir: PathBuf) -> Self {
        Self { home, data_dir }
    }

    /// Skill 主副本目录。
    pub fn skill_storage(&self) -> PathBuf {
        self.data_dir.join("skills")
    }

    /// 某个客户端读写提示词与 Skill 的磁盘位置。
    pub fn client(&self, client: CustomizationClient) -> ClientPaths {
        let config_dir = match client {
            CustomizationClient::Claude => self.home.join(".claude"),
            CustomizationClient::Codex => self.home.join(".codex"),
        };
        ClientPaths {
            client,
            prompt_file: config_dir.join(client.prompt_file_name()),
            skills_dir: config_dir.join("skills"),
            config_dir,
        }
    }
}

/// 单个客户端在磁盘上的位置。
pub struct ClientPaths {
    pub client: CustomizationClient,
    pub config_dir: PathBuf,
    pub prompt_file: PathBuf,
    pub skills_dir: PathBuf,
}

impl ClientPaths {
    /// 该客户端目录里存在、但不归本应用管理的 Skill 目录名。
    pub fn unmanaged_skills(&self, managed: &[String]) -> Result<Vec<String>> {
        let entries = match std::fs::read_dir(&self.skills_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut names = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.starts_with('.') && !managed.contains(name))
            .collect::<Vec<_>>();
        names.sort();
        Ok(names)
    }
}

/// 把主目录前缀换成 `~`，供界面显示；复制路径仍用完整路径。
pub fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// 校验一个目录名可以安全地拼进路径：单段、非空、非 `.`/`..`、不含分隔符。
pub fn validate_directory_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    let invalid = || Error::Config(format!("invalid skill directory: {raw:?}"));
    if name.is_empty() || name == "." || name == ".." {
        return Err(invalid());
    }
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(invalid());
    }
    Ok(name.to_owned())
}

/// 原子写入文本文件：先写同目录临时文件再重命名，避免半截文件被客户端读到。
pub fn write_text_atomic(path: &Path, content: &str) -> Result<()> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|ext| ext.to_str()).unwrap_or("txt")
    ));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path)?;
    Ok(())
}

/// 递归复制目录；符号链接按链接目标复制，不跟随，避免把外部目录整棵拷进来。
pub fn copy_dir(source: &Path, destination: &Path) -> Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            let resolved = std::fs::read_link(entry.path())?;
            let source_path = entry.path();
            let real = if resolved.is_absolute() {
                resolved
            } else {
                source_path
                    .parent()
                    .map(|parent| parent.join(&resolved))
                    .unwrap_or(resolved)
            };
            if real.is_file() {
                std::fs::copy(&real, &target)?;
            }
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}