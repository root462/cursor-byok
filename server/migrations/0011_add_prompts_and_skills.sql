-- Claude CLI / Codex Desktop 的提示词模板与 Skill 管理。
-- 提示词：每个客户端最多一条 enabled，启用时投影到 CLAUDE.md / AGENTS.md。
CREATE TABLE prompt_templates (
    id TEXT NOT NULL,
    client TEXT NOT NULL CHECK (client IN ('claude', 'codex')),
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (client, id)
);

-- 一个客户端只能有一条生效提示词。
CREATE UNIQUE INDEX prompt_templates_single_enabled
    ON prompt_templates(client) WHERE enabled = 1;

-- Skill：主副本存放在数据目录的 skills/ 下，按客户端启用后同步到各自的 skills 目录。
CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    directory TEXT NOT NULL UNIQUE,
    enabled_claude INTEGER NOT NULL DEFAULT 0 CHECK (enabled_claude IN (0, 1)),
    enabled_codex INTEGER NOT NULL DEFAULT 0 CHECK (enabled_codex IN (0, 1)),
    installed_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX skills_directory ON skills(directory);