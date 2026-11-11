//! Persists client-isolated model configurations (Claude CLI, Codex Desktop).
use std::collections::HashSet;

use sqlx::{Sqlite, Transaction};

use crate::{
    model::{model_hash, normalize_model_input, ModelConfig, ModelConfigInput},
    Error, Result,
};

use super::{
    models::{model_from_row, to_i64},
    now_ms, Store,
};

const CLIENT_MODEL_COLUMNS: &str = r#"
    model_hash, sort_order, display_name, group_name, model_type, base_url, use_full_url, api_key, tooltip_data,
    model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
    openai_extra_params_json, custom_headers_enabled, custom_headers_json,
    anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
    max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
    thinking_budget_tokens, created_at_ms, updated_at_ms
"#;

impl Store {
    pub async fn client_models(&self, client: &str) -> Result<Vec<ModelConfig>> {
        let query = format!(
            "SELECT {CLIENT_MODEL_COLUMNS} FROM client_model_configs WHERE client = ? ORDER BY sort_order, display_name"
        );
        sqlx::query(&query)
            .bind(client)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(model_from_row)
            .collect()
    }

    pub async fn client_model(&self, client: &str, hash: &str) -> Result<Option<ModelConfig>> {
        let query = format!(
            "SELECT {CLIENT_MODEL_COLUMNS} FROM client_model_configs WHERE client = ? AND model_hash = ?"
        );
        sqlx::query(&query)
            .bind(client)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .map(model_from_row)
            .transpose()
    }

    pub async fn any_client_model(&self, hash: &str) -> Result<Option<ModelConfig>> {
        let query = format!(
            "SELECT {CLIENT_MODEL_COLUMNS} FROM client_model_configs WHERE model_hash = ? LIMIT 1"
        );
        sqlx::query(&query)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .map(model_from_row)
            .transpose()
    }

    pub async fn create_client_model(
        &self,
        client: &str,
        input: &ModelConfigInput,
    ) -> Result<ModelConfig> {
        let mut models = self
            .create_client_models(client, std::slice::from_ref(input))
            .await?;
        Ok(models.remove(0))
    }

    pub async fn create_client_models(
        &self,
        client: &str,
        inputs: &[ModelConfigInput],
    ) -> Result<Vec<ModelConfig>> {
        if inputs.is_empty() {
            return Err(Error::Config("at least one model is required".into()));
        }
        let mut normalized = Vec::with_capacity(inputs.len());
        let mut hashes = HashSet::with_capacity(inputs.len());
        for input in inputs {
            let input = normalize_model_input(input)?;
            let hash = model_hash(&input)?;
            if !hashes.insert(hash.clone()) {
                return Err(Error::Config("model configurations must be unique".into()));
            }
            normalized.push((hash, input));
        }

        let mut tx = self.pool.begin().await?;
        let mut created = Vec::with_capacity(normalized.len());
        for (hash, input) in normalized {
            if !insert_client_model(&mut tx, client, &hash, &input).await? {
                return Err(Error::Config(format!(
                    "model configuration already exists: {hash}"
                )));
            }
            let query = format!(
                "SELECT {CLIENT_MODEL_COLUMNS} FROM client_model_configs WHERE client = ? AND model_hash = ?"
            );
            let model = sqlx::query(&query)
                .bind(client)
                .bind(&hash)
                .fetch_one(&mut *tx)
                .await
                .map(model_from_row)??;
            created.push(model);
        }
        tx.commit().await?;
        Ok(created)
    }

    pub async fn update_client_model(
        &self,
        client: &str,
        hash: &str,
        input: &ModelConfigInput,
    ) -> Result<ModelConfig> {
        let normalized = normalize_model_input(input)?;
        let new_hash = model_hash(&normalized)?;
        let mut tx = self.pool.begin().await?;
        let existing_query = format!(
            "SELECT {CLIENT_MODEL_COLUMNS} FROM client_model_configs WHERE client = ? AND model_hash = ?"
        );
        let existing = sqlx::query(&existing_query)
            .bind(client)
            .bind(hash)
            .fetch_optional(&mut *tx)
            .await?
            .map(model_from_row)
            .transpose()?
            .ok_or_else(|| Error::RunNotFound(format!("model configuration not found: {hash}")))?;

        let now = now_ms();
        if new_hash == hash {
            let update_query = r#"UPDATE client_model_configs SET
                sort_order = ?, display_name = ?, group_name = ?, model_type = ?, base_url = ?,
                use_full_url = ?, api_key = ?, tooltip_data = ?, model_id = ?, reasoning_effort = ?,
                openai_endpoint = ?, openai_extra_params_enabled = ?, openai_extra_params_json = ?,
                custom_headers_enabled = ?, custom_headers_json = ?, anthropic_extra_params_enabled = ?,
                anthropic_extra_params_json = ?, context_window_tokens = ?, max_completion_tokens = ?,
                anthropic_max_tokens = ?, anthropic_thinking_effort = ?, thinking_budget_tokens = ?,
                updated_at_ms = ?
                WHERE client = ? AND model_hash = ?"#;

            sqlx::query(update_query)
                .bind(normalized.sort_order)
                .bind(&normalized.display_name)
                .bind(&normalized.group_name)
                .bind(normalized.model_type.as_str())
                .bind(&normalized.base_url)
                .bind(normalized.use_full_url)
                .bind(&normalized.api_key)
                .bind(&normalized.tooltip_data)
                .bind(&normalized.model_id)
                .bind(&normalized.reasoning_effort)
                .bind(&normalized.openai_endpoint)
                .bind(normalized.openai_extra_params_enabled)
                .bind(serde_json::to_string(&normalized.openai_extra_params)?)
                .bind(normalized.custom_headers_enabled)
                .bind(serde_json::to_string(&normalized.custom_headers)?)
                .bind(normalized.anthropic_extra_params_enabled)
                .bind(serde_json::to_string(&normalized.anthropic_extra_params)?)
                .bind(normalized.context_window_tokens.map(to_i64).transpose()?)
                .bind(normalized.max_completion_tokens.map(to_i64).transpose()?)
                .bind(normalized.anthropic_max_tokens.map(to_i64).transpose()?)
                .bind(&normalized.anthropic_thinking_effort)
                .bind(normalized.thinking_budget_tokens.map(to_i64).transpose()?)
                .bind(now)
                .bind(client)
                .bind(hash)
                .execute(&mut *tx)
                .await?;
        } else {
            let check_query =
                "SELECT 1 FROM client_model_configs WHERE client = ? AND model_hash = ?";
            if sqlx::query(check_query)
                .bind(client)
                .bind(&new_hash)
                .fetch_optional(&mut *tx)
                .await?
                .is_some()
            {
                return Err(Error::Config(format!(
                    "model configuration already exists: {new_hash}"
                )));
            }

            sqlx::query("DELETE FROM client_model_configs WHERE client = ? AND model_hash = ?")
                .bind(client)
                .bind(hash)
                .execute(&mut *tx)
                .await?;

            insert_client_model(&mut tx, client, &new_hash, &normalized).await?;
        }

        let model = sqlx::query(&existing_query)
            .bind(client)
            .bind(&new_hash)
            .fetch_one(&mut *tx)
            .await
            .map(model_from_row)??;
        tx.commit().await?;
        let _ = existing;
        Ok(model)
    }

    pub async fn delete_client_model(&self, client: &str, hash: &str) -> Result<()> {
        let result =
            sqlx::query("DELETE FROM client_model_configs WHERE client = ? AND model_hash = ?")
                .bind(client)
                .bind(hash)
                .execute(&self.pool)
                .await?;
        if result.rows_affected() == 0 {
            return Err(Error::RunNotFound(format!(
                "model configuration not found: {hash}"
            )));
        }
        Ok(())
    }

    pub async fn reorder_client_models(
        &self,
        client: &str,
        hashes: &[String],
    ) -> Result<Vec<ModelConfig>> {
        let mut tx = self.pool.begin().await?;
        let now = now_ms();
        for (index, hash) in hashes.iter().enumerate() {
            let sort_order = i64::try_from(index)
                .map_err(|_| Error::Config("sort order is too large".into()))?;
            let query =
                "UPDATE client_model_configs SET sort_order = ?, updated_at_ms = ? WHERE client = ? AND model_hash = ?";
            let result = sqlx::query(query)
                .bind(sort_order)
                .bind(now)
                .bind(client)
                .bind(hash)
                .execute(&mut *tx)
                .await?;
            if result.rows_affected() == 0 {
                return Err(Error::RunNotFound(format!(
                    "model configuration not found: {hash}"
                )));
            }
        }
        tx.commit().await?;
        self.client_models(client).await
    }
}

async fn insert_client_model(
    transaction: &mut Transaction<'_, Sqlite>,
    client: &str,
    hash: &str,
    input: &ModelConfigInput,
) -> Result<bool> {
    let now = now_ms();
    let query = r#"INSERT INTO client_model_configs(
        client, model_hash, sort_order, display_name, group_name, model_type, base_url, use_full_url, api_key, tooltip_data,
        model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
        openai_extra_params_json, custom_headers_enabled, custom_headers_json,
        anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
        max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
        thinking_budget_tokens, created_at_ms, updated_at_ms
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ) ON CONFLICT(client, model_hash) DO NOTHING"#;

    let result = sqlx::query(query)
        .bind(client)
        .bind(hash)
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.group_name)
        .bind(input.model_type.as_str())
        .bind(&input.base_url)
        .bind(input.use_full_url)
        .bind(&input.api_key)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(&input.openai_endpoint)
        .bind(input.openai_extra_params_enabled)
        .bind(serde_json::to_string(&input.openai_extra_params)?)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(input.anthropic_extra_params_enabled)
        .bind(serde_json::to_string(&input.anthropic_extra_params)?)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_completion_tokens.map(to_i64).transpose()?)
        .bind(input.anthropic_max_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(now)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ModelType;

    fn sample_model(name: &str) -> ModelConfigInput {
        ModelConfigInput {
            sort_order: 0,
            display_name: name.into(),
            group_name: None,
            model_type: ModelType::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            use_full_url: false,
            api_key: "sk-ant-test".into(),
            tooltip_data: name.into(),
            model_id: "claude-3-5-sonnet".into(),
            reasoning_effort: None,
            openai_endpoint: "".into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: Some(200_000),
            max_completion_tokens: Some(8_192),
            anthropic_max_tokens: Some(8_192),
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }
    }

    #[tokio::test]
    async fn client_models_are_isolated_between_clients_and_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        // 1. Create model for Cursor in store.models
        let cursor_model = store
            .create_model(&sample_model("Cursor Model"))
            .await
            .unwrap();

        // 2. Create model for Claude
        let claude_model = store
            .create_client_model("claude", &sample_model("Claude Model"))
            .await
            .unwrap();

        // 3. Create model for Codex
        let codex_model = store
            .create_client_model("codex", &sample_model("Codex Model"))
            .await
            .unwrap();

        // Verify Cursor only sees Cursor model
        let cursor_models = store.models().await.unwrap();
        assert_eq!(cursor_models.len(), 1);
        assert_eq!(cursor_models[0].display_name, "Cursor Model");

        // Verify Claude only sees Claude model
        let claude_models = store.client_models("claude").await.unwrap();
        assert_eq!(claude_models.len(), 1);
        assert_eq!(claude_models[0].display_name, "Claude Model");

        // Verify Codex only sees Codex model
        let codex_models = store.client_models("codex").await.unwrap();
        assert_eq!(codex_models.len(), 1);
        assert_eq!(codex_models[0].display_name, "Codex Model");

        // Verify any_client_model finds client models across clients
        assert!(store.any_client_model(&claude_model.model_hash).await.unwrap().is_some());
        assert!(store.any_client_model(&codex_model.model_hash).await.unwrap().is_some());
        assert!(store.any_client_model("nonexistent").await.unwrap().is_none());

        // Test update and delete in isolation
        let mut update_input = sample_model("Updated Claude Model");
        update_input.model_id = "claude-3-7-sonnet".into();
        let updated = store
            .update_client_model("claude", &claude_model.model_hash, &update_input)
            .await
            .unwrap();
        assert_eq!(updated.display_name, "Updated Claude Model");

        store
            .delete_client_model("claude", &updated.model_hash)
            .await
            .unwrap();
        assert!(store.client_models("claude").await.unwrap().is_empty());
        assert_eq!(store.client_models("codex").await.unwrap().len(), 1);
        assert_eq!(store.models().await.unwrap().len(), 1);

        let _ = cursor_model;
        let _ = codex_model;
    }
}
