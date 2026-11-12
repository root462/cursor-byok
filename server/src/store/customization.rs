//! 持久化提示词模板与已安装 Skill 的记录。
use sqlx::Row;

use crate::{
    model::{CustomizationClient, InstalledSkill, PromptTemplate},
    Result,
};

use super::{now_ms, Store};

const PROMPT_COLUMNS: &str = "id, name, content, enabled, created_at_ms, updated_at_ms";
const SKILL_COLUMNS: &str = r#"
    id, name, description, directory, enabled_claude, enabled_codex, installed_at_ms, updated_at_ms
"#;

fn prompt_from_row(row: sqlx::sqlite::SqliteRow) -> Result<PromptTemplate> {
    Ok(PromptTemplate {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        content: row.try_get("content")?,
        enabled: row.try_get::<i64, _>("enabled")? != 0,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn skill_from_row(row: sqlx::sqlite::SqliteRow) -> Result<InstalledSkill> {
    Ok(InstalledSkill {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        directory: row.try_get("directory")?,
        enabled_claude: row.try_get::<i64, _>("enabled_claude")? != 0,
        enabled_codex: row.try_get::<i64, _>("enabled_codex")? != 0,
        installed_at_ms: row.try_get("installed_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

impl Store {
    pub async fn prompt_templates(&self, client: CustomizationClient) -> Result<Vec<PromptTemplate>> {
        let query = format!(
            "SELECT {PROMPT_COLUMNS} FROM prompt_templates WHERE client = ? ORDER BY created_at_ms, id"
        );
        sqlx::query(&query)
            .bind(client.as_str())
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(prompt_from_row)
            .collect()
    }

    pub async fn prompt_template(
        &self,
        client: CustomizationClient,
        id: &str,
    ) -> Result<Option<PromptTemplate>> {
        let query = format!(
            "SELECT {PROMPT_COLUMNS} FROM prompt_templates WHERE client = ? AND id = ?"
        );
        sqlx::query(&query)
            .bind(client.as_str())
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(prompt_from_row)
            .transpose()
    }

    /// 写入一条提示词模板。启用时先停用同客户端的其它模板，保证最多一条生效。
    pub async fn save_prompt_template(
        &self,
        client: CustomizationClient,
        prompt: &PromptTemplate,
    ) -> Result<()> {
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        if prompt.enabled {
            sqlx::query("UPDATE prompt_templates SET enabled = 0 WHERE client = ?")
                .bind(client.as_str())
                .execute(&mut *transaction)
                .await?;
        }
        sqlx::query(
            "INSERT INTO prompt_templates(client, id, name, content, enabled, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(client, id) DO UPDATE SET
                name = excluded.name,
                content = excluded.content,
                enabled = excluded.enabled,
                updated_at_ms = excluded.updated_at_ms",
        )
        .bind(client.as_str())
        .bind(&prompt.id)
        .bind(&prompt.name)
        .bind(&prompt.content)
        .bind(i64::from(prompt.enabled))
        .bind(prompt.created_at_ms)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// 只调整启用状态，不改动内容。启用时顺带停用同客户端的其它模板。
    pub async fn set_prompt_enabled(
        &self,
        client: CustomizationClient,
        id: &str,
        enabled: bool,
    ) -> Result<PromptTemplate> {
        let Some(mut prompt) = self.prompt_template(client, id).await? else {
            return Err(crate::Error::RunNotFound(format!("prompt {id}")));
        };
        prompt.enabled = enabled;
        self.save_prompt_template(client, &prompt).await?;
        Ok(prompt)
    }

    pub async fn delete_prompt_template(
        &self,
        client: CustomizationClient,
        id: &str,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("DELETE FROM prompt_templates WHERE client = ? AND id = ?")
            .bind(client.as_str())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn skills(&self) -> Result<Vec<InstalledSkill>> {
        let query = format!("SELECT {SKILL_COLUMNS} FROM skills ORDER BY name, id");
        sqlx::query(&query)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(skill_from_row)
            .collect()
    }

    pub async fn skill(&self, id: &str) -> Result<Option<InstalledSkill>> {
        let query = format!("SELECT {SKILL_COLUMNS} FROM skills WHERE id = ?");
        sqlx::query(&query)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(skill_from_row)
            .transpose()
    }

    pub async fn save_skill(&self, skill: &InstalledSkill) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO skills(id, name, description, directory, enabled_claude, enabled_codex, installed_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                directory = excluded.directory,
                enabled_claude = excluded.enabled_claude,
                enabled_codex = excluded.enabled_codex,
                updated_at_ms = excluded.updated_at_ms",
        )
        .bind(&skill.id)
        .bind(&skill.name)
        .bind(&skill.description)
        .bind(&skill.directory)
        .bind(i64::from(skill.enabled_claude))
        .bind(i64::from(skill.enabled_codex))
        .bind(skill.installed_at_ms)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_skill(&self, id: &str) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("DELETE FROM skills WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// 该目录名是否已被一条记录占用（用于安装前的重名检查）。
    pub async fn skill_directory_taken(&self, directory: &str) -> Result<bool> {
        let existing: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM skills WHERE directory = ? LIMIT 1")
                .bind(directory)
                .fetch_optional(&self.pool)
                .await?;
        Ok(existing.is_some())
    }
}