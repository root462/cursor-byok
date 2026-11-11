//! Provides aggregate data for the control API.
//! Efficient database aggregates for the desktop overview.

use std::collections::BTreeMap;

use chrono::Utc;
use sqlx::Row;

use crate::{
    model::{Overview, OverviewMetrics, TokenUsageBucket, TokenUsageGranularity},
    Result,
};

use super::Store;

const OVERVIEW_DAYS: u64 = 365;
const MAX_RANGE_BUCKETS: i64 = 60;
const MAX_EXPLICIT_BUCKETS: i64 = 1440;
const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

impl Store {
    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        model_hashes: Option<&str>,
        bucket_ms: Option<i64>,
    ) -> Result<Overview> {
        let call_row = sqlx::query(
            "SELECT
                COUNT(*) AS llm_calls,
                COALESCE(SUM(status = 'completed'), 0) AS successful_calls,
                COALESCE(SUM(status != 'completed'), 0) AS failed_calls
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))",
        )
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_one(&self.pool)
        .await?;
        let token_row = sqlx::query(&format!(
            "SELECT
                COALESCE(SUM({fresh_input}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))",
            fresh_input = fresh_input_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_one(&self.pool)
        .await?;

        let pricing = self.pricing_settings().await?;

        let model_token_rows = sqlx::query(&format!(
            "SELECT
                model_hash,
                model_id,
                COALESCE(SUM({fresh_input}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))
             GROUP BY model_hash, model_id",
            fresh_input = fresh_input_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_all(&self.pool)
        .await?;

        let mut input_cost_usd = 0.0;
        let mut output_cost_usd = 0.0;
        let mut cache_read_cost_usd = 0.0;
        let mut cache_write_cost_usd = 0.0;

        for row in &model_token_rows {
            let model_hash = row.try_get::<Option<String>, _>("model_hash")?;
            let model_id: String = row.try_get("model_id")?;
            let row_input = non_negative(row.try_get("input_tokens")?);
            let row_cache_read = non_negative(row.try_get("cache_read_tokens")?);
            let row_cache_write = non_negative(row.try_get("cache_write_tokens")?);
            let row_output = non_negative(row.try_get("output_tokens")?);

            let price = pricing.effective_pricing(model_hash.as_deref(), &model_id);
            input_cost_usd += (row_input as f64 / 1_000_000.0) * price.input_per_million;
            output_cost_usd += (row_output as f64 / 1_000_000.0) * price.output_per_million;
            cache_read_cost_usd +=
                (row_cache_read as f64 / 1_000_000.0) * price.cache_read_per_million;
            cache_write_cost_usd +=
                (row_cache_write as f64 / 1_000_000.0) * price.cache_write_per_million;
        }

        let estimated_cache_cost_usd = cache_read_cost_usd + cache_write_cost_usd;
        let estimated_cost_usd = input_cost_usd + output_cost_usd + estimated_cache_cost_usd;

        let input_tokens = non_negative(token_row.try_get("input_tokens")?);
        let cache_read_tokens = non_negative(token_row.try_get("cache_read_tokens")?);
        let cache_write_tokens = non_negative(token_row.try_get("cache_write_tokens")?);
        let output_tokens = non_negative(token_row.try_get("output_tokens")?);
        let prompt_tokens = saturating_sum(&[input_tokens, cache_read_tokens, cache_write_tokens]);
        let metrics = OverviewMetrics {
            llm_calls: call_row.try_get("llm_calls")?,
            successful_calls: call_row.try_get("successful_calls")?,
            failed_calls: call_row.try_get("failed_calls")?,
            token_usage: prompt_tokens.saturating_add(output_tokens),
            prompt_tokens,
            input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            estimated_cost_usd,
            estimated_cache_cost_usd,
            input_cost_usd,
            output_cost_usd,
            cache_read_cost_usd,
            cache_write_cost_usd,
        };

        let (token_usage_granularity, bucket_ms, series_start_ms, bucket_count) =
            token_usage_buckets(start_ms, end_ms, bucket_ms);
        let rows = sqlx::query(&format!(
            "SELECT
                (created_at_ms / {bucket_ms}) * {bucket_ms} AS bucket_start_ms,
                COALESCE(SUM({fresh_input}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE created_at_ms >= ?
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))
             GROUP BY bucket_start_ms
             ORDER BY bucket_start_ms",
            fresh_input = fresh_input_sql(),
        ))
        .bind(start_ms.unwrap_or(series_start_ms).max(series_start_ms))
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_all(&self.pool)
        .await?;
        let mut recorded = rows
            .into_iter()
            .map(|row| {
                let bucket_start_ms: i64 = row.try_get("bucket_start_ms")?;
                Ok((
                    bucket_start_ms,
                    TokenUsageBucket {
                        bucket_start_ms,
                        input_tokens: non_negative(row.try_get("input_tokens")?),
                        cache_read_tokens: non_negative(row.try_get("cache_read_tokens")?),
                        cache_write_tokens: non_negative(row.try_get("cache_write_tokens")?),
                        output_tokens: non_negative(row.try_get("output_tokens")?),
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let token_usage_series = (0..bucket_count)
            .map(|offset| series_start_ms.saturating_add(offset.saturating_mul(bucket_ms)))
            .map(|bucket_start_ms| {
                recorded
                    .remove(&bucket_start_ms)
                    .unwrap_or(TokenUsageBucket {
                        bucket_start_ms,
                        ..TokenUsageBucket::default()
                    })
            })
            .collect();

        Ok(Overview {
            metrics,
            token_usage_granularity,
            token_usage_series,
        })
    }
}

fn token_usage_buckets(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    requested_bucket_ms: Option<i64>,
) -> (TokenUsageGranularity, i64, i64, i64) {
    if let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) {
        let duration_ms = end_ms.saturating_sub(start_ms).max(1);
        let explicit_bucket_ms = requested_bucket_ms.filter(|bucket_ms| *bucket_ms >= MINUTE_MS);
        let bucket_ms = explicit_bucket_ms.unwrap_or({
            if duration_ms <= HOUR_MS {
                MINUTE_MS
            } else if duration_ms <= MAX_RANGE_BUCKETS * HOUR_MS {
                HOUR_MS
            } else {
                DAY_MS
            }
        });
        let granularity = if bucket_ms < HOUR_MS {
            TokenUsageGranularity::Minute
        } else if bucket_ms < DAY_MS {
            TokenUsageGranularity::Hour
        } else {
            TokenUsageGranularity::Day
        };
        let max_buckets = if explicit_bucket_ms.is_some() {
            MAX_EXPLICIT_BUCKETS
        } else {
            MAX_RANGE_BUCKETS
        };
        let last_bucket_ms = end_ms.saturating_sub(1).div_euclid(bucket_ms) * bucket_ms;
        let first_bucket_ms = start_ms.div_euclid(bucket_ms) * bucket_ms;
        let bucket_count =
            ((last_bucket_ms - first_bucket_ms).div_euclid(bucket_ms) + 1).clamp(1, max_buckets);
        let series_start_ms =
            last_bucket_ms.saturating_sub((bucket_count - 1).saturating_mul(bucket_ms));
        return (granularity, bucket_ms, series_start_ms, bucket_count);
    }

    let today_start_ms = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|value| value.and_utc().timestamp_millis())
        .unwrap_or(0);
    let series_start_ms = today_start_ms.saturating_sub(
        i64::try_from(OVERVIEW_DAYS - 1)
            .unwrap_or(0)
            .saturating_mul(DAY_MS),
    );
    (
        TokenUsageGranularity::Day,
        DAY_MS,
        series_start_ms,
        i64::try_from(OVERVIEW_DAYS).unwrap_or(0),
    )
}

fn fresh_input_sql() -> &'static str {
    "CASE
        WHEN request_type = 'anthropic' THEN MAX(0, COALESCE(input_tokens, 0))
        ELSE MAX(0, COALESCE(input_tokens, 0)
            - COALESCE(cache_read_tokens, 0)
            - COALESCE(cache_write_tokens, 0))
     END"
}

fn non_negative(value: i64) -> i64 {
    value.max(0)
}

fn saturating_sum(values: &[i64]) -> i64 {
    values
        .iter()
        .fold(0_i64, |total, value| total.saturating_add(*value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::settings::{ModelPricing, TokenPricingSettings};

    #[tokio::test]
    async fn overview_calculates_estimated_cost_per_model() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();

        // Configure custom pricing for "custom-hash"
        let mut models = std::collections::BTreeMap::new();
        models.insert(
            "custom-hash".into(),
            ModelPricing {
                input_per_million: 10.0,
                output_per_million: 20.0,
                cache_read_per_million: 1.0,
                cache_write_per_million: 2.0,
            },
        );
        store
            .set_pricing_settings(TokenPricingSettings {
                input_per_million: 1.0,
                output_per_million: 2.0,
                cache_read_per_million: 0.1,
                cache_write_per_million: 0.2,
                models,
            })
            .await
            .unwrap();

        // Insert call 1: custom-hash (1M input, 1M output, 1M cache read, 1M cache write)
        // input: 10, output: 20, cache read: 1, cache write: 2 => total 33
        sqlx::query(
            "INSERT INTO llm_calls (
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id,
                display_name, status, created_at_ms, message_count, tool_count, detailed,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
            ) VALUES (
                'c1', 'r1', 'conv1', 0, 'custom-hash',
                'openai', 'http://127.0.0.1', 'openai', 'http://127.0.0.1/chat', 'custom-model',
                'Custom Model', 'completed', 1000, 1, 0, 0,
                3000000, 1000000, 1000000, 1000000
            )",
        )
        .execute(store.pool())
        .await
        .unwrap();

        // Insert call 2: claude-3-5-sonnet (built-in default: 3.0 / 15.0 / 0.3 / 3.75)
        // anthropic request_type: input_tokens is fresh input
        // 1M input ($3), 1M output ($15), 1M cache read ($0.3), 1M cache write ($3.75) => total 22.05
        sqlx::query(
            "INSERT INTO llm_calls (
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id,
                display_name, status, created_at_ms, message_count, tool_count, detailed,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
            ) VALUES (
                'c2', 'r2', 'conv2', 0, 'sonnet-hash',
                'anthropic', 'http://127.0.0.1', 'anthropic', 'http://127.0.0.1/messages', 'claude-3-5-sonnet-20241022',
                'Claude 3.5 Sonnet', 'completed', 2000, 1, 0, 0,
                1000000, 1000000, 1000000, 1000000
            )"
        )
        .execute(store.pool())
        .await
        .unwrap();

        // Insert call 3: unknown model without custom price -> falls back to global default (1.0 / 2.0 / 0.1 / 0.2)
        // 1M input ($1), 1M output ($2), 0 cache => total 3
        sqlx::query(
            "INSERT INTO llm_calls (
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id,
                display_name, status, created_at_ms, message_count, tool_count, detailed,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
            ) VALUES (
                'c3', 'r3', 'conv3', 0, NULL,
                'openai', 'http://127.0.0.1', 'openai', 'http://127.0.0.1/chat', 'llama-3',
                'Llama 3', 'completed', 3000, 1, 0, 0,
                1000000, 1000000, 0, 0
            )",
        )
        .execute(store.pool())
        .await
        .unwrap();

        let overview = store
            .overview(Some(0), Some(5000), None, None)
            .await
            .unwrap();

        // Total calls = 3
        assert_eq!(overview.metrics.llm_calls, 3);
        // Cost: 33.0 (call 1) + 22.05 (call 2) + 3.0 (call 3) = 58.05
        assert!((overview.metrics.estimated_cost_usd - 58.05).abs() < 1e-4);
        // Cache cost: 3.0 (call 1) + 4.05 (call 2) = 7.05
        assert!((overview.metrics.estimated_cache_cost_usd - 7.05).abs() < 1e-4);
    }
}
