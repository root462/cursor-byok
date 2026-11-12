//! 提示词模板：数据库保存全部模板，启用的那一条投影到客户端的全局提示词文件。
use std::fs;

use crate::{
    model::{CustomizationClient, PromptInput, PromptSettings, PromptTemplate},
    store::Store,
    Error, Result,
};

use super::{display_path, write_text_atomic, Paths};

pub struct PromptService;

fn new_id() -> String {
    format!("prompt-{}", uuid::Uuid::new_v4())
}

impl PromptService {
    pub async fn settings(
        store: &Store,
        paths: &Paths,
        client: CustomizationClient,
    ) -> Result<PromptSettings> {
        let locations = paths.client(client);
        let prompts = store.prompt_templates(client).await?;
        let file_content = match fs::read_to_string(&locations.prompt_file) {
            Ok(content) => Some(content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(PromptSettings {
            client,
            display_path: display_path(&locations.prompt_file, paths.home()),
            file_path: locations.prompt_file.to_string_lossy().to_string(),
            file_content,
            prompts,
        })
    }

    /// 新建或更新一条模板；启用时立刻投影到目标文件。
    pub async fn save(
        store: &Store,
        paths: &Paths,
        client: CustomizationClient,
        input: PromptInput,
    ) -> Result<PromptSettings> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::Config("prompt name must not be empty".into()));
        }
        let locations = paths.client(client);
        let now = crate::store::now_ms();
        let existing = match input.id.as_deref() {
            Some(id) => store.prompt_template(client, id).await?,
            None => None,
        };
        let prompt = PromptTemplate {
            id: existing
                .as_ref()
                .map(|prompt| prompt.id.clone())
                .unwrap_or_else(new_id),
            name: name.to_owned(),
            content: input.content,
            enabled: input.enabled,
            created_at_ms: existing
                .as_ref()
                .map(|prompt| prompt.created_at_ms)
                .unwrap_or(now),
            updated_at_ms: now,
        };

        if prompt.enabled {
            write_text_atomic(&locations.prompt_file, &prompt.content)?;
        } else if existing.as_ref().is_some_and(|prompt| prompt.enabled) {
            // 停用当前生效的模板：只有没有别的模板接替时才清空文件。
            fs::write(&locations.prompt_file, "")?;
        }
        store.save_prompt_template(client, &prompt).await?;
        Self::settings(store, paths, client).await
    }

    /// 启用或停用一条模板。
    ///
    /// 启用前先把磁盘上的当前内容回填进正在生效的模板，避免丢失用户的直接编辑；
    /// 停用时清空目标文件，让客户端回到没有全局提示词的状态。
    pub async fn set_enabled(
        store: &Store,
        paths: &Paths,
        client: CustomizationClient,
        id: &str,
        enabled: bool,
    ) -> Result<PromptSettings> {
        let locations = paths.client(client);
        let Some(target) = store.prompt_template(client, id).await? else {
            return Err(Error::RunNotFound(format!("prompt {id}")));
        };

        if enabled {
            // 客户端或用户可能直接改过文件，回填后再切换。
            let current = store
                .prompt_templates(client)
                .await?
                .into_iter()
                .find(|prompt| prompt.enabled && prompt.id != target.id);
            if let Some(mut current) = current {
                if let Ok(content) = fs::read_to_string(&locations.prompt_file) {
                    if !content.trim().is_empty() && content != current.content {
                        current.content = content;
                        store.save_prompt_template(client, &current).await?;
                    }
                }
            }
            write_text_atomic(&locations.prompt_file, &target.content)?;
        } else {
            write_text_atomic(&locations.prompt_file, "")?;
        }

        store.set_prompt_enabled(client, id, enabled).await?;
        Self::settings(store, paths, client).await
    }

    pub async fn delete(
        store: &Store,
        paths: &Paths,
        client: CustomizationClient,
        id: &str,
    ) -> Result<PromptSettings> {
        if let Some(prompt) = store.prompt_template(client, id).await? {
            if prompt.enabled {
                return Err(Error::Config("无法删除已启用的提示词".into()));
            }
        }
        store.delete_prompt_template(client, id).await?;
        Self::settings(store, paths, client).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    struct Fixture {
        _directory: tempfile::TempDir,
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
            _directory: directory,
            store,
            paths,
        }
    }

    #[tokio::test]
    async fn enabling_a_prompt_writes_the_client_file() {
        let fixture = fixture().await;
        let (store, paths) = (&fixture.store, &fixture.paths);

        let saved = PromptService::save(
            store,
            paths,
            CustomizationClient::Claude,
            PromptInput {
                id: None,
                name: "first".into(),
                content: "来自模板的指令".into(),
                enabled: true,
            },
        )
        .await
        .unwrap();

        let file = paths.client(CustomizationClient::Claude).prompt_file;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "来自模板的指令");
        assert_eq!(saved.prompts.len(), 1);
        assert!(saved.prompts[0].enabled);
        assert!(saved.display_path.starts_with('~'));
    }

    #[tokio::test]
    async fn enabling_another_prompt_disables_the_previous_one() {
        let fixture = fixture().await;
        let (store, paths) = (&fixture.store, &fixture.paths);

        PromptService::save(
            store,
            paths,
            CustomizationClient::Codex,
            PromptInput {
                id: None,
                name: "first".into(),
                content: "第一条".into(),
                enabled: true,
            },
        )
        .await
        .unwrap();
        let second = PromptService::save(
            store,
            paths,
            CustomizationClient::Codex,
            PromptInput {
                id: None,
                name: "second".into(),
                content: "第二条".into(),
                enabled: false,
            },
        )
        .await
        .unwrap();
        let second_id = second.prompts.iter().find(|p| p.name == "second").unwrap().id.clone();

        let settings = PromptService::set_enabled(
            store,
            paths,
            CustomizationClient::Codex,
            &second_id,
            true,
        )
        .await
        .unwrap();

        let enabled = settings.prompts.iter().filter(|p| p.enabled).collect::<Vec<_>>();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].name, "second");
        let file = paths.client(CustomizationClient::Codex).prompt_file;
        assert_eq!(std::fs::read_to_string(file).unwrap(), "第二条");
    }

    #[tokio::test]
    async fn enabling_backfills_edits_made_directly_to_the_file() {
        let fixture = fixture().await;
        let (store, paths) = (&fixture.store, &fixture.paths);

        PromptService::save(
            store,
            paths,
            CustomizationClient::Claude,
            PromptInput {
                id: None,
                name: "first".into(),
                content: "原始内容".into(),
                enabled: true,
            },
        )
        .await
        .unwrap();
        let next = PromptService::save(
            store,
            paths,
            CustomizationClient::Claude,
            PromptInput {
                id: None,
                name: "next".into(),
                content: "下一条".into(),
                enabled: false,
            },
        )
        .await
        .unwrap();
        let next_id = next.prompts.iter().find(|p| p.name == "next").unwrap().id.clone();

        // 用户直接改文件，随后切到另一条模板。
        let file = paths.client(CustomizationClient::Claude).prompt_file;
        std::fs::write(&file, "手改过的内容").unwrap();
        let settings = PromptService::set_enabled(
            store,
            paths,
            CustomizationClient::Claude,
            &next_id,
            true,
        )
        .await
        .unwrap();

        let backfilled = settings.prompts.iter().find(|p| p.name == "first").unwrap();
        assert_eq!(backfilled.content, "手改过的内容");
        assert!(!backfilled.enabled);
    }

    #[tokio::test]
    async fn an_enabled_prompt_cannot_be_deleted() {
        let fixture = fixture().await;
        let (store, paths) = (&fixture.store, &fixture.paths);

        let saved = PromptService::save(
            store,
            paths,
            CustomizationClient::Claude,
            PromptInput {
                id: None,
                name: "only".into(),
                content: "内容".into(),
                enabled: true,
            },
        )
        .await
        .unwrap();
        let id = saved.prompts[0].id.clone();

        assert!(PromptService::delete(store, paths, CustomizationClient::Claude, &id).await.is_err());
    }

    #[tokio::test]
    async fn disabling_the_enabled_prompt_clears_the_client_file() {
        let fixture = fixture().await;
        let (store, paths) = (&fixture.store, &fixture.paths);

        let saved = PromptService::save(
            store,
            paths,
            CustomizationClient::Claude,
            PromptInput {
                id: None,
                name: "only".into(),
                content: "生效中的指令".into(),
                enabled: true,
            },
        )
        .await
        .unwrap();
        let id = saved.prompts[0].id.clone();

        let settings =
            PromptService::set_enabled(store, paths, CustomizationClient::Claude, &id, false)
                .await
                .unwrap();

        assert!(!settings.prompts[0].enabled);
        assert_eq!(settings.file_content.as_deref(), Some(""));
    }
}
