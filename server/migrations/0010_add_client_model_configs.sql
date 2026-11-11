-- Isolated model configurations for other clients (Claude CLI, Codex Desktop).
-- Cursor continues to use model_configs; this table stores per-client isolated models.
CREATE TABLE client_model_configs (
    client TEXT NOT NULL CHECK(client IN ('claude', 'codex')),
    model_hash TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL,
    group_name TEXT,
    model_type TEXT NOT NULL CHECK(model_type IN ('openai', 'anthropic')),
    base_url TEXT NOT NULL,
    use_full_url INTEGER NOT NULL DEFAULT 0 CHECK(use_full_url IN (0, 1)),
    api_key TEXT NOT NULL,
    tooltip_data TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL,
    reasoning_effort TEXT,
    openai_endpoint TEXT NOT NULL DEFAULT '',
    openai_extra_params_enabled INTEGER NOT NULL DEFAULT 0 CHECK(openai_extra_params_enabled IN (0, 1)),
    openai_extra_params_json TEXT NOT NULL DEFAULT '{}',
    custom_headers_enabled INTEGER NOT NULL DEFAULT 0 CHECK(custom_headers_enabled IN (0, 1)),
    custom_headers_json TEXT NOT NULL DEFAULT '{}',
    anthropic_extra_params_enabled INTEGER NOT NULL DEFAULT 0 CHECK(anthropic_extra_params_enabled IN (0, 1)),
    anthropic_extra_params_json TEXT NOT NULL DEFAULT '{}',
    context_window_tokens INTEGER,
    max_completion_tokens INTEGER,
    anthropic_max_tokens INTEGER,
    anthropic_thinking_effort TEXT,
    thinking_budget_tokens INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (client, model_hash)
);

CREATE INDEX client_model_configs_sort ON client_model_configs(client, sort_order, display_name);
