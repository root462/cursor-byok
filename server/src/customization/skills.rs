//! Skill：主副本保存在数据目录，按客户端启用后同步到各自的 `skills/` 目录。
//!
//! 安装有两种来源：本地文件夹（可带脚本等附件），或直接粘贴一段 `SKILL.md`。
//! 同步优先用符号链接，失败则复制，和 cc-switch 的做法一致。
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::{
    model::{
        CustomizationClient, InstalledSkill, SkillClientPaths, SkillImportInput, SkillPasteInput,
        SkillSettings,
    },
    store::Store,
    Error, Result,
};

use super::{copy_dir, display_path, validate_directory_name, write_text_atomic, Paths};

/// 安装来源：用户选定的本地文件夹，里面必须直接包含 `SKILL.md`。
#[derive(Clone, Debug, Deserialize)]
pub struct SkillInstallInput {
    pub source_path: String,
    #[serde(default)]
    pub enabled_claude: bool,
    #[serde(default)]
    pub enabled_codex: bool,
}

pub struct SkillService;

#[derive(Deserialize)]
struct SkillFrontMatter {
    name: Option<String>,
    description: Option<String>,
}

/// 从 `SKILL.md` 的 YAML front matter 读取名称与描述；解析失败时退回目录名。
fn read_metadata(skill_md: &Path, fallback: &str) -> (String, Option<String>) {
    let Ok(content) = std::fs::read_to_string(skill_md) else {
        return (fallback.to_owned(), None);
    };
    parse_metadata(&content).unwrap_or_else(|| (fallback.to_owned(), None))
}

/// 解析一段 `SKILL.md` 文本的 front matter；必须写在文档开头，且带非空 `name`。
fn parse_metadata(content: &str) -> Option<(String, Option<String>)> {
    let content = content.trim_start_matches('\u{feff}');
    let mut parts = content.splitn(3, "---");
    if !parts.next().is_some_and(|head| head.trim().is_empty()) {
        return None;
    }
    let front = parts.next()?;
    let meta: SkillFrontMatter = serde_yaml::from_str(front.trim()).ok()?;
    let name = meta.name.filter(|name| !name.trim().is_empty())?;
    Some((name, meta.description))
}

/// 把 Skill 名称转成可安全用作目录名的一段：非字母数字一律折成 `-`。
fn directory_from_name(name: &str) -> String {
    let slug = name
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>();
    let slug = slug.trim_matches('-').to_lowercase();
    if slug.is_empty() { "skill".to_owned() } else { slug }
}

/// Skill 的主副本与客户端目录之间是否已经指向同一份内容。
fn is_synced(link: &Path, source: &Path) -> bool {
    match std::fs::symlink_metadata(link) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::read_link(link).map(|target| target == source).unwrap_or(false)
        }
        Ok(metadata) if metadata.is_dir() => false,
        Ok(_) => false,
        Err(_) => false,
    }
}

fn remove_entry(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            std::fs::remove_file(path)?;
        }
        Ok(_) => std::fs::remove_dir_all(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(unix)]
fn create_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
}

#[cfg(not(unix))]
fn create_link(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks are unsupported on this platform",
    ))
}

impl SkillService {
    /// 主副本目录：数据目录下的 `skills/`。
    fn storage_dir(paths: &Paths) -> Result<PathBuf> {
        let dir = paths.skill_storage();
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 把主副本同步到某个客户端的 skills 目录；已同步时不做任何事。
    fn sync_to_client(paths: &Paths, directory: &str, client: CustomizationClient) -> Result<()> {
        let directory = validate_directory_name(directory)?;
        let source = Self::storage_dir(paths)?.join(&directory);
        if !source.join("SKILL.md").is_file() {
            return Err(Error::Config(format!(
                "Skill {directory} 的主副本缺少 SKILL.md"
            )));
        }
        let locations = paths.client(client);
        std::fs::create_dir_all(&locations.skills_dir)?;
        let destination = locations.skills_dir.join(&directory);
        if is_synced(&destination, &source) {
            return Ok(());
        }
        if destination.exists() {
            remove_entry(&destination)?;
        }
        match create_link(&source, &destination) {
            Ok(()) => Ok(()),
            // 符号链接不可用时退回复制，保证功能可用。
            Err(_) => copy_dir(&source, &destination),
        }
    }

    /// 从客户端的 skills 目录撤掉这个 Skill；只删同步过去的那一份。
    fn remove_from_client(paths: &Paths, directory: &str, client: CustomizationClient) -> Result<()> {
        let directory = validate_directory_name(directory)?;
        let destination = paths.client(client).skills_dir.join(&directory);
        remove_entry(&destination)
    }

    fn sync_enabled(paths: &Paths, skill: &InstalledSkill) -> Result<()> {
        for (client, enabled) in [
            (CustomizationClient::Claude, skill.enabled_claude),
            (CustomizationClient::Codex, skill.enabled_codex),
        ] {
            if enabled {
                Self::sync_to_client(paths, &skill.directory, client)?;
            }
        }
        Ok(())
    }

    pub async fn settings(store: &Store, paths: &Paths) -> Result<SkillSettings> {
        let storage = Self::storage_dir(paths)?;
        let skills = store.skills().await?;
        let managed = skills
            .iter()
            .map(|skill| skill.directory.clone())
            .collect::<Vec<_>>();
        let clients = [CustomizationClient::Claude, CustomizationClient::Codex]
            .into_iter()
            .map(|client| {
                let locations = paths.client(client);
                let unmanaged = locations.unmanaged_skills(&managed).unwrap_or_default();
                SkillClientPaths {
                    client,
                    display_path: display_path(&locations.skills_dir, paths.home()),
                    skills_path: locations.skills_dir.to_string_lossy().to_string(),
                    unmanaged,
                }
            })
            .collect();
        Ok(SkillSettings {
            display_path: display_path(&storage, paths.home()),
            storage_path: storage.to_string_lossy().to_string(),
            clients,
            skills,
        })
    }

    /// 把本地目录安装为主副本。
    pub async fn install(store: &Store, paths: &Paths, input: SkillInstallInput) -> Result<SkillSettings> {
        let source = PathBuf::from(input.source_path.trim());
        if !source.join("SKILL.md").is_file() {
            return Err(Error::Config(format!(
                "{} 不是 Skill 目录：缺少 SKILL.md",
                source.display()
            )));
        }
        let fallback = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
            .to_owned();
        let directory = validate_directory_name(&fallback)?;
        if store.skill_directory_taken(&directory).await? {
            return Err(Error::Config(format!("已存在同名 Skill：{directory}")));
        }

        let storage = Self::storage_dir(paths)?;
        let destination = storage.join(&directory);
        if destination.exists() {
            remove_entry(&destination)?;
        }
        copy_dir(&source, &destination)?;

        let (name, description) = read_metadata(&destination.join("SKILL.md"), &directory);
        let now = crate::store::now_ms();
        let skill = InstalledSkill {
            id: format!("skill-{}", uuid::Uuid::new_v4()),
            name,
            description,
            directory,
            enabled_claude: input.enabled_claude,
            enabled_codex: input.enabled_codex,
            installed_at_ms: now,
            updated_at_ms: now,
        };
        store.save_skill(&skill).await?;
        Self::sync_enabled(paths, &skill)?;
        Self::settings(store, paths).await
    }

    /// 把一段粘贴的 `SKILL.md` 文本安装成 Skill。
    ///
    /// 目录名取自 front matter 的 `name`（折成安全片段），因此粘贴安装天然是
    /// 单文件 Skill；需要附带脚本或其他资源时仍从目录安装。
    pub async fn install_from_markdown(
        store: &Store,
        paths: &Paths,
        input: SkillPasteInput,
    ) -> Result<SkillSettings> {
        let markdown = input.markdown.trim();
        if markdown.is_empty() {
            return Err(Error::Config("粘贴的 SKILL.md 内容为空".into()));
        }
        let Some((name, description)) = parse_metadata(markdown) else {
            return Err(Error::Config(
                "粘贴的内容需要以 --- 开头的 front matter，并在其中提供 name".into(),
            ));
        };
        let directory = validate_directory_name(&directory_from_name(&name))?;
        if store.skill_directory_taken(&directory).await? {
            return Err(Error::Config(format!("已存在同名 Skill：{directory}")));
        }

        let destination = Self::storage_dir(paths)?.join(&directory);
        if destination.exists() {
            remove_entry(&destination)?;
        }
        std::fs::create_dir_all(&destination)?;
        write_text_atomic(&destination.join("SKILL.md"), &format!("{markdown}\n"))?;

        let now = crate::store::now_ms();
        let skill = InstalledSkill {
            id: format!("skill-{}", uuid::Uuid::new_v4()),
            name,
            description,
            directory,
            enabled_claude: input.enabled_claude,
            enabled_codex: input.enabled_codex,
            installed_at_ms: now,
            updated_at_ms: now,
        };
        store.save_skill(&skill).await?;
        Self::sync_enabled(paths, &skill)?;
        Self::settings(store, paths).await
    }

    /// 把某个客户端目录里已有的 Skill 纳管：复制成主副本并记录。
    pub async fn import_from_client(
        store: &Store,
        paths: &Paths,
        client: CustomizationClient,
        input: SkillImportInput,
    ) -> Result<SkillSettings> {
        let directory = validate_directory_name(&input.directory)?;
        let source = paths.client(client).skills_dir.join(&directory);
        if !source.join("SKILL.md").is_file() {
            return Err(Error::Config(format!(
                "{} 不是 Skill 目录：缺少 SKILL.md",
                source.display()
            )));
        }
        if store.skill_directory_taken(&directory).await? {
            return Err(Error::Config(format!("已存在同名 Skill：{directory}")));
        }

        let destination = Self::storage_dir(paths)?.join(&directory);
        if destination.exists() {
            remove_entry(&destination)?;
        }
        copy_dir(&source, &destination)?;

        let (name, description) = read_metadata(&destination.join("SKILL.md"), &directory);
        let now = crate::store::now_ms();
        let skill = InstalledSkill {
            id: format!("skill-{}", uuid::Uuid::new_v4()),
            name,
            description,
            directory,
            enabled_claude: input.enabled_claude,
            enabled_codex: input.enabled_codex,
            installed_at_ms: now,
            updated_at_ms: now,
        };
        store.save_skill(&skill).await?;
        Self::sync_enabled(paths, &skill)?;
        Self::settings(store, paths).await
    }

    /// 切换某个客户端的启用状态，并立即同步或撤销磁盘上的副本。
    pub async fn set_enabled(
        store: &Store,
        paths: &Paths,
        id: &str,
        client: CustomizationClient,
        enabled: bool,
    ) -> Result<SkillSettings> {
        let Some(mut skill) = store.skill(id).await? else {
            return Err(Error::RunNotFound(format!("skill {id}")));
        };
        match client {
            CustomizationClient::Claude => skill.enabled_claude = enabled,
            CustomizationClient::Codex => skill.enabled_codex = enabled,
        }
        store.save_skill(&skill).await?;
        if enabled {
            Self::sync_to_client(paths, &skill.directory, client)?;
        } else {
            Self::remove_from_client(paths, &skill.directory, client)?;
        }
        Self::settings(store, paths).await
    }

    /// 卸载：从所有客户端撤掉副本，再删除主副本与记录。
    pub async fn uninstall(store: &Store, paths: &Paths, id: &str) -> Result<SkillSettings> {
        let Some(skill) = store.skill(id).await? else {
            return Err(Error::RunNotFound(format!("skill {id}")));
        };
        for client in [CustomizationClient::Claude, CustomizationClient::Codex] {
            Self::remove_from_client(paths, &skill.directory, client)?;
        }
        let storage = Self::storage_dir(paths)?.join(&skill.directory);
        remove_entry(&storage)?;
        store.delete_skill(id).await?;
        Self::settings(store, paths).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    struct Fixture {
        directory: tempfile::TempDir,
        store: Store,
        paths: Paths,
    }

    async fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let store = Store::connect(&format!(
            "sqlite://{}",
            root.join("test.db").display()
        ))
        .await
        .unwrap();
        let paths = Paths::rooted(root.join("home"), root.join("data"));
        Fixture {
            directory,
            store,
            paths,
        }
    }

    /// 在临时目录里造一个最小可用的 Skill 来源目录。
    fn source_skill(root: &Path, name: &str) -> PathBuf {
        let directory = root.join(name);
        std::fs::create_dir_all(directory.join("scripts")).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {name}-display\ndescription: 测试用技能\n---\n\n正文\n"),
        )
        .unwrap();
        std::fs::write(directory.join("scripts/run.sh"), "echo hi\n").unwrap();
        directory
    }

    fn install_input(source: PathBuf) -> SkillInstallInput {
        SkillInstallInput {
            source_path: source.to_string_lossy().to_string(),
            enabled_claude: true,
            enabled_codex: false,
        }
    }

    #[tokio::test]
    async fn installing_copies_the_skill_and_links_it_into_the_client() {
        let fixture = fixture().await;
        let source = source_skill(fixture.directory.path(), "demo");

        let settings =
            SkillService::install(&fixture.store, &fixture.paths, install_input(source.clone()))
                .await
                .unwrap();

        let skill = &settings.skills[0];
        assert_eq!(skill.name, "demo-display");
        assert_eq!(skill.description.as_deref(), Some("测试用技能"));
        assert!(skill.enabled_claude);
        assert!(!skill.enabled_codex);

        // 主副本完整复制了目录内容。
        let stored = fixture.paths.skill_storage().join(&skill.directory);
        assert!(stored.join("SKILL.md").is_file());
        assert!(stored.join("scripts/run.sh").is_file());

        // Claude 目录里出现了这个 Skill（符号链接或复制均可）。
        let linked = fixture
            .paths
            .client(CustomizationClient::Claude)
            .skills_dir
            .join(&skill.directory);
        assert!(linked.join("SKILL.md").is_file());
        // 未启用的 Codex 目录里不应出现。
        let absent = fixture
            .paths
            .client(CustomizationClient::Codex)
            .skills_dir
            .join(&skill.directory);
        assert!(!absent.exists());
    }

    #[tokio::test]
    async fn enabling_for_a_client_adds_and_removes_the_directory() {
        let fixture = fixture().await;
        let source = source_skill(fixture.directory.path(), "demo");
        let installed =
            SkillService::install(&fixture.store, &fixture.paths, install_input(source))
                .await
                .unwrap();
        let skill = installed.skills[0].clone();
        let codex_dir = fixture
            .paths
            .client(CustomizationClient::Codex)
            .skills_dir
            .join(&skill.directory);

        SkillService::set_enabled(
            &fixture.store,
            &fixture.paths,
            &skill.id,
            CustomizationClient::Codex,
            true,
        )
        .await
        .unwrap();
        assert!(codex_dir.join("SKILL.md").is_file());

        SkillService::set_enabled(
            &fixture.store,
            &fixture.paths,
            &skill.id,
            CustomizationClient::Codex,
            false,
        )
        .await
        .unwrap();
        assert!(!codex_dir.exists());
        // 撤销同步不应影响主副本。
        assert!(fixture
            .paths
            .skill_storage()
            .join(&skill.directory)
            .join("SKILL.md")
            .is_file());
    }

    #[tokio::test]
    async fn reinstalling_the_same_directory_is_rejected() {
        let fixture = fixture().await;
        let source = source_skill(fixture.directory.path(), "demo");
        SkillService::install(&fixture.store, &fixture.paths, install_input(source.clone()))
            .await
            .unwrap();
        assert!(SkillService::install(&fixture.store, &fixture.paths, install_input(source))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn uninstalling_removes_the_copies_and_the_record() {
        let fixture = fixture().await;
        let source = source_skill(fixture.directory.path(), "demo");
        let installed =
            SkillService::install(&fixture.store, &fixture.paths, install_input(source))
                .await
                .unwrap();
        let skill = installed.skills[0].clone();

        let settings = SkillService::uninstall(&fixture.store, &fixture.paths, &skill.id)
            .await
            .unwrap();

        assert!(settings.skills.is_empty());
        assert!(!fixture.paths.client(CustomizationClient::Claude).skills_dir.join(&skill.directory).exists());
        assert!(!fixture.paths.skill_storage().join(&skill.directory).exists());
    }

    #[tokio::test]
    async fn importing_takes_over_a_skill_that_already_sits_in_a_client_directory() {
        let fixture = fixture().await;
        // 用户此前手动放进 Claude 目录的 Skill。
        let source = source_skill(
            &fixture.paths.client(CustomizationClient::Claude).skills_dir,
            "handwritten",
        );
        assert!(source.join("SKILL.md").is_file());

        let settings = SkillService::import_from_client(
            &fixture.store,
            &fixture.paths,
            CustomizationClient::Claude,
            SkillImportInput {
                directory: "handwritten".into(),
                enabled_claude: true,
                enabled_codex: false,
            },
        )
        .await
        .unwrap();

        assert_eq!(settings.skills.len(), 1);
        assert_eq!(settings.skills[0].directory, "handwritten");
        assert!(fixture
            .paths
            .skill_storage()
            .join("handwritten/SKILL.md")
            .is_file());
    }

    #[tokio::test]
    async fn unmanaged_directories_are_reported_per_client() {
        let fixture = fixture().await;
        std::fs::create_dir_all(
            fixture
                .paths
                .client(CustomizationClient::Codex)
                .skills_dir
                .join("loose"),
        )
        .unwrap();
        std::fs::write(
            fixture
                .paths
                .client(CustomizationClient::Codex)
                .skills_dir
                .join("loose/SKILL.md"),
            "---\nname: loose\n---\n",
        )
        .unwrap();

        let settings = SkillService::settings(&fixture.store, &fixture.paths)
            .await
            .unwrap();
        let codex = settings
            .clients
            .iter()
            .find(|c| c.client == CustomizationClient::Codex)
            .unwrap();
        assert_eq!(codex.unmanaged, vec!["loose".to_string()]);
        assert!(codex.display_path.starts_with('~'));
    }

    #[tokio::test]
    async fn a_source_without_skill_manifest_is_rejected() {
        let fixture = fixture().await;
        let empty = fixture.directory.path().join("not-a-skill");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(SkillService::install(&fixture.store, &fixture.paths, install_input(empty))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn pasted_markdown_becomes_a_skill_named_by_its_front_matter() {
        let fixture = fixture().await;

        let settings = SkillService::install_from_markdown(
            &fixture.store,
            &fixture.paths,
            SkillPasteInput {
                markdown: "---\nname: Release Notes\ndescription: 整理发版说明\n---\n\n正文\n".into(),
                enabled_claude: true,
                enabled_codex: false,
            },
        )
        .await
        .unwrap();

        let skill = &settings.skills[0];
        assert_eq!(skill.name, "Release Notes");
        assert_eq!(skill.description.as_deref(), Some("整理发版说明"));
        // 目录名由名称折成安全片段。
        assert_eq!(skill.directory, "release-notes");
        assert!(fixture
            .paths
            .skill_storage()
            .join(&skill.directory)
            .join("SKILL.md")
            .is_file());
        assert!(fixture
            .paths
            .client(CustomizationClient::Claude)
            .skills_dir
            .join(&skill.directory)
            .join("SKILL.md")
            .is_file());
    }

    #[tokio::test]
    async fn pasted_markdown_needs_a_front_matter_name() {
        let fixture = fixture().await;
        assert!(SkillService::install_from_markdown(
            &fixture.store,
            &fixture.paths,
            SkillPasteInput {
                markdown: "只有正文，没有 front matter\n".into(),
                enabled_claude: false,
                enabled_codex: false,
            },
        )
        .await
        .is_err());
    }
}
