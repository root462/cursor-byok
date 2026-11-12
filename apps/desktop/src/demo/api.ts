import type {
  CallDetail,
  CursorHarnessStatus,
  ExternalApiSettings,
  LlmCall,
  Model,
  Overview,
  OverviewTokenUsageBucket,
  PromptSettings,
  ProxySettings,
  SkillSettings,
  StatisticsStorage,
  TabSettings,
} from "../shared/api";

const API_ROOT = "/__byok-api__/api";
const FIXED_NOW = Date.UTC(2026, 7, 27, 8, 0, 0);

const models: Model[] = [
  createModel({ hash: "mock-claude-sonnet", order: 1, name: "Claude Sonnet 4", type: "anthropic", url: "https://api.anthropic.com", modelId: "claude-sonnet-4-20250514" }),
  createModel({ hash: "mock-claude-opus", order: 2, name: "Claude Opus 4", type: "anthropic", url: "https://api.anthropic.com", modelId: "claude-opus-4-20250514" }),
  createModel({ hash: "mock-gpt", order: 3, name: "GPT-5.2", type: "openai", url: "https://api.openai.com", modelId: "gpt-5.2" }),
  createModel({ hash: "mock-o3", order: 4, name: "o3", type: "openai", url: "https://api.openai.com", modelId: "o3" }),
  createModel({ hash: "mock-deepseek-v3", order: 5, name: "DeepSeek V3.2", type: "openai", url: "https://api.deepseek.com", modelId: "deepseek-chat", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-deepseek-r1", order: 6, name: "DeepSeek R1", type: "openai", url: "https://api.deepseek.com", modelId: "deepseek-reasoner", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-gemini-pro", order: 7, name: "Gemini 2.5 Pro", type: "openai", url: "https://generativelanguage.googleapis.com", modelId: "gemini-2.5-pro", endpoint: "/v1beta/openai/chat/completions" }),
  createModel({ hash: "mock-gemini-flash", order: 8, name: "Gemini 2.5 Flash", type: "openai", url: "https://generativelanguage.googleapis.com", modelId: "gemini-2.5-flash", endpoint: "/v1beta/openai/chat/completions" }),
  createModel({ hash: "mock-qwen-max", order: 9, name: "Qwen3 Max", type: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode", modelId: "qwen3-max", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-qwen-plus", order: 10, name: "Qwen Plus", type: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode", modelId: "qwen-plus", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-kimi-k2", order: 11, name: "Kimi K2", type: "openai", url: "https://api.moonshot.cn", modelId: "kimi-k2-0711-preview", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-kimi-128k", order: 12, name: "Moonshot V1 128K", type: "openai", url: "https://api.moonshot.cn", modelId: "moonshot-v1-128k", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-glm-45", order: 13, name: "GLM-4.5", type: "openai", url: "https://open.bigmodel.cn", modelId: "glm-4.5", endpoint: "/api/paas/v4/chat/completions" }),
  createModel({ hash: "mock-glm-air", order: 14, name: "GLM-4.5-Air", type: "openai", url: "https://open.bigmodel.cn", modelId: "glm-4.5-air", endpoint: "/api/paas/v4/chat/completions" }),
  createModel({ hash: "mock-mistral-large", order: 15, name: "Mistral Large", type: "openai", url: "https://api.mistral.ai", modelId: "mistral-large-latest", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-mistral-small", order: 16, name: "Mistral Small", type: "openai", url: "https://api.mistral.ai", modelId: "mistral-small-latest", endpoint: "/v1/chat/completions" }),
];

const calls: LlmCall[] = Array.from({ length: 24 }, (_, index) => {
  const model = models[index % models.length];
  const failed = index === 7 || index === 19;
  return {
    call_kind: "provider_llm",
    route: "local_byok",
    client: index % 3 === 0 ? "codex" : index % 3 === 1 ? "claude" : "cursor",
    call_id: `mock-call-${String(index + 1).padStart(3, "0")}`,
    run_id: `mock-run-${Math.floor(index / 3) + 1}`,
    conversation_id: `mock-conversation-${Math.floor(index / 4) + 1}`,
    provider_call_index: index + 1,
    model_hash: model.model_hash,
    provider_type: model.type,
    provider_url: model.base_url,
    request_type: model.type === "anthropic" ? "messages" : "responses",
    request_url: model.type === "anthropic" ? `${model.base_url}/v1/messages` : `${model.base_url}${model.openai_endpoint}`,
    model_id: model.model_id,
    display_name: model.display_name,
    reasoning_effort: index % 2 === 0 ? "high" : null,
    fast: index % 3 === 0,
    status: failed ? "failed" : "completed",
    finish_reason: failed ? null : "stop",
    created_at_ms: FIXED_NOW - index * 3 * 60_000,
    ttfb_ms: 210 + index * 13,
    ttfr_ms: 290 + index * 15,
    ttft_ms: 370 + index * 17,
    duration_ms: failed ? 812 : 1_420 + index * 71,
    input_tokens: 4_800 + index * 337,
    output_tokens: failed ? 0 : 820 + index * 43,
    total_tokens: failed ? 4_800 + index * 337 : 5_620 + index * 380,
    cache_read_tokens: 3_100 + index * 251,
    cache_write_tokens: 320 + index * 19,
    reasoning_tokens: index % 2 === 0 ? 420 + index * 11 : null,
    message_count: 14 + (index % 8),
    tool_count: 3 + (index % 5),
    http_status: failed ? 429 : 200,
    error_kind: failed ? "provider_rate_limit" : null,
    error_message: failed ? "Mock provider rate limit" : null,
    detailed: true,
    estimated_cost_usd: failed
      ? null
      : (4_800 + index * 337) * 3e-6 + (820 + index * 43) * 15e-6,
  };
});

let harnessStatus: CursorHarnessStatus = {
  platform: "macos",
  ca: "ready",
  configured_models: models.length,
  enabled_models: models.length,
  integration: "enabled",
  settings_applied: true,
  proxy_url: "http://127.0.0.1:54321",
  ca_install_command: null,
};

let detailed = true;
let portSettings = { proxy_port: 0, service_port: 0 };
let externalApiSettings: ExternalApiSettings = { enabled: false, api_key: "" };
let proxySettings: ProxySettings = {
  mode: "default",
  address: "",
  auth_enabled: false,
  username: "",
  has_password: false,
};
let tabSettings: TabSettings = { mode: "direct", address: "", api_key: "", model: "" };

const demoPromptContent = {
  claude: "始终用中文回答。\n改动代码前先说明计划，改完给出验证命令。\n",
  codex: "Keep diffs minimal and run the project checks before finishing.\n",
};

let promptSettings: Record<"claude" | "codex", PromptSettings> = {
  claude: {
    client: "claude",
    file_path: "/Users/demo/.claude/CLAUDE.md",
    display_path: "~/.claude/CLAUDE.md",
    file_content: demoPromptContent.claude,
    prompts: [
      {
        id: "prompt-claude-default",
        name: "默认工作约定",
        content: demoPromptContent.claude,
        enabled: true,
        created_at_ms: FIXED_NOW - 86_400_000,
        updated_at_ms: FIXED_NOW - 3_600_000,
      },
      {
        id: "prompt-claude-review",
        name: "代码评审语气",
        content: "评审时先给结论，再列证据；不要复述完整文件。\n",
        enabled: false,
        created_at_ms: FIXED_NOW - 172_800_000,
        updated_at_ms: FIXED_NOW - 172_800_000,
      },
    ],
  },
  codex: {
    client: "codex",
    file_path: "/Users/demo/.codex/AGENTS.md",
    display_path: "~/.codex/AGENTS.md",
    file_content: "",
    prompts: [],
  },
};

let skillSettings: SkillSettings = {
  storage_path: "/Users/demo/Library/Application Support/cursor-byok/skills",
  display_path: "~/Library/Application Support/cursor-byok/skills",
  clients: [
    {
      client: "claude",
      skills_path: "/Users/demo/.claude/skills",
      display_path: "~/.claude/skills",
      unmanaged: ["legacy-notes"],
    },
    {
      client: "codex",
      skills_path: "/Users/demo/.codex/skills",
      display_path: "~/.codex/skills",
      unmanaged: [],
    },
  ],
  skills: [
    {
      id: "skill-demo-release",
      name: "Release notes",
      description: "把本次提交整理成发版说明",
      directory: "release-notes",
      enabled_claude: true,
      enabled_codex: false,
      installed_at_ms: FIXED_NOW - 86_400_000,
      updated_at_ms: FIXED_NOW - 86_400_000,
    },
  ],
};
let storage: StatisticsStorage = { call_count: calls.length, trace_count: calls.length };

export function installDemoApi() {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(requestUrl, window.location.href);
    if (!url.pathname.startsWith(API_ROOT)) return nativeFetch(input, init);

    const path = url.pathname.slice(API_ROOT.length) || "/";
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = await readBody(input, init);

    if (path === "/models" && method === "GET") return json(models);
    if (path === "/models" && method === "POST") return json(models);
    if (path === "/models/order") return json(models);
    if (path === "/models/discover") return json({ models: models.map((model) => model.model_id) });
    if (path === "/models/import-v0049" && method === "GET") {
      return json({ source: "demo", total: 0, new_models: 0, existing_models: 0, models: [] });
    }
    if (path === "/models/import-v0049") return json({ imported: 0, skipped: 0, total: 0 });
    if (/^\/models\/[^/]+\/test\/[^/]+$/.test(path) && method === "POST") {
      return json({ duration_ms: 1_284, first_valid_response_ms: 418, output_tokens: 42, tokens_per_second: 38.6, tokens_estimated: false, output: "Mock connectivity test passed." });
    }
    if (/^\/models\/[^/]+\/test\/[^/]+$/.test(path) || /^\/models\/[^/]+$/.test(path)) {
      return method === "DELETE" ? empty() : json(models[0]);
    }
    if (path === "/overview") return json(createOverview(url.searchParams));
    if (path === "/llm-calls") return json(calls);
    if (path.startsWith("/llm-calls/")) return json(createCallDetail(path.slice("/llm-calls/".length)));
    if (path === "/harness/cursor/status") return json(harnessStatus);
    if (path === "/skills" && method === "GET") return json(skillSettings);
    if (path === "/skills" && method === "POST") return json(skillSettings);
    if (path.startsWith("/skills/import/")) return json(skillSettings);
    if (/^\/skills\/[^/]+\/(claude|codex)$/.test(path) && method === "PUT") {
      const [, id, client] = path.split("/");
      skillSettings = {
        ...skillSettings,
        skills: skillSettings.skills.map((skill) => skill.id === id
          ? {
            ...skill,
            enabled_claude: client === "claude" ? Boolean((body as { enabled?: unknown } | null)?.enabled) : skill.enabled_claude,
            enabled_codex: client === "codex" ? Boolean((body as { enabled?: unknown } | null)?.enabled) : skill.enabled_codex,
          }
          : skill),
      };
      return json(skillSettings);
    }
    if (/^\/skills\/[^/]+$/.test(path) && method === "DELETE") {
      const id = path.slice("/skills/".length);
      skillSettings = { ...skillSettings, skills: skillSettings.skills.filter((skill) => skill.id !== id) };
      return json(skillSettings);
    }
    if (/^\/harness\/(claude|codex)\/prompts$/.test(path)) {
      const client = path.split("/")[2] as "claude" | "codex";
      if (method === "GET") return json(promptSettings[client]);
      const input = body as { id?: string | null; name: string; content: string; enabled: boolean };
      const current = promptSettings[client];
      const existing = input.id ? current.prompts.find((prompt) => prompt.id === input.id) : undefined;
      const prompt = {
        id: existing?.id ?? `prompt-${client}-${current.prompts.length + 1}`,
        name: input.name,
        content: input.content,
        enabled: input.enabled,
        created_at_ms: existing?.created_at_ms ?? FIXED_NOW,
        updated_at_ms: FIXED_NOW,
      };
      promptSettings[client] = {
        ...current,
        prompts: [
          ...current.prompts
            .filter((item) => item.id !== prompt.id)
            .map((item) => (prompt.enabled ? { ...item, enabled: false } : item)),
          prompt,
        ],
        file_content: prompt.enabled ? prompt.content : current.file_content,
      };
      return json(promptSettings[client]);
    }
    if (/^\/harness\/(claude|codex)\/prompts\//.test(path)) {
      const [, , client] = path.split("/");
      return json(promptSettings[client as "claude" | "codex"]);
    }
    if (path === "/harness/cursor/runtime-status") return json({ mismatch_count: 0, last_detected_at_ms: null });
    if (path === "/harness/cursor/ca/initialize") return json(harnessStatus);
    if (path === "/harness/cursor/enabled") {
      const enabled = Boolean((body as { enabled?: unknown } | null)?.enabled);
      harnessStatus = {
        ...harnessStatus,
        integration: enabled ? "enabled" : "disabled",
        settings_applied: enabled,
        proxy_url: enabled ? "http://127.0.0.1:54321" : null,
      };
      return json(harnessStatus);
    }
    if (path === "/settings/observability" && method === "GET") return json({ detailed });
    if (path === "/settings/observability") {
      detailed = Boolean((body as { detailed?: unknown } | null)?.detailed);
      return json({ detailed });
    }
    if (path === "/settings/ports" && method === "GET") return json(portSettings);
    if (path === "/settings/ports") {
      portSettings = body as typeof portSettings;
      return json(portSettings);
    }
    if (path === "/settings/external-api" && method === "GET") return json(externalApiSettings);
    if (path === "/settings/external-api") {
      externalApiSettings = body as ExternalApiSettings;
      return json(externalApiSettings);
    }
    if (path === "/settings/storage/statistics" && method === "GET") return json(storage);
    if (path === "/settings/storage/statistics") {
      const scope = (body as { scope?: string } | null)?.scope ?? "details";
      storage = scope === "all" ? { call_count: 0, trace_count: 0 } : storage;
      return json(storage);
    }
    if (path === "/settings/proxy" && method === "GET") return json(proxySettings);
    if (path === "/settings/proxy") {
      const next = body as Partial<ProxySettings>;
      proxySettings = { ...proxySettings, ...next, has_password: Boolean(next.has_password) };
      return json(proxySettings);
    }
    if (path === "/settings/tab" && method === "GET") return json(tabSettings);
    if (path === "/settings/tab/models") return json({ models: models.map((model) => model.model_id) });
    if (path === "/settings/tab") {
      tabSettings = body as TabSettings;
      return json(tabSettings);
    }
    if (path === "/settings/desktop" && method === "GET") return json({ silent_start: false, show_dock_icon: true });
    if (path === "/settings/desktop") return json(body);
    if (path === "/desktop/open-external-url") {
      const target = (body as { url?: string } | null)?.url;
      if (target) {
        const next = new URL(target, window.location.href);
        if (next.origin === window.location.origin && next.hash) window.location.hash = next.hash;
      }
      return empty();
    }
    if (path === "/desktop/switch-version") {
      return empty();
    }
    if (path === "/desktop/release-history") {
      return json([
        {
          version: "1.0.5",
          tagName: "v1.0.5",
          name: "v1.0.5",
          publishedAt: "2026-11-10T12:00:00Z",
          body: "1.0.5 release",
          prerelease: false,
        },
        {
          version: "1.0.4",
          tagName: "v1.0.4",
          name: "v1.0.4",
          publishedAt: "2026-11-08T12:00:00Z",
          body: "1.0.4 release",
          prerelease: false,
        },
      ]);
    }

    return json({ message: `Unhandled demo endpoint: ${method} ${path}` }, 404);
  };
}

function createModel({ hash, order, name, type, url, modelId, endpoint = "/v1/responses" }: {
  hash: string;
  order: number;
  name: string;
  type: Model["type"];
  url: string;
  modelId: string;
  endpoint?: string;
}): Model {
  return {
    model_hash: hash,
    sort_order: order,
    display_name: name,
    group_name: null,
    type,
    base_url: url,
    use_full_url: false,
    api_key: "demo-key",
    tooltip_data: `${name} Mock 通道`,
    model_id: modelId,
    reasoning_effort: type === "openai" ? "high" : null,
    openai_endpoint: type === "openai" ? endpoint : "",
    openai_extra_params_enabled: false,
    openai_extra_params: {},
    custom_headers_enabled: false,
    custom_headers: {},
    anthropic_extra_params_enabled: false,
    anthropic_extra_params: {},
    context_window_tokens: 200_000,
    max_completion_tokens: type === "openai" ? 32_000 : null,
    anthropic_max_tokens: type === "anthropic" ? 32_000 : null,
    anthropic_thinking_effort: type === "anthropic" ? "high" : null,
    thinking_budget_tokens: null,
    created_at_ms: FIXED_NOW - order * 86_400_000,
    updated_at_ms: FIXED_NOW,
  };
}

function createOverview(params: URLSearchParams): Overview {
  const start = Number(params.get("start_ms"));
  const end = Number(params.get("end_ms"));
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 365 * 86_400_000;
  const granularity = duration <= 2 * 60 * 60_000 ? "minute" : duration <= 2 * 86_400_000 ? "hour" : "day";
  const step = granularity === "minute" ? 60_000 : granularity === "hour" ? 3_600_000 : 86_400_000;
  const count = granularity === "minute" ? Math.min(60, Math.max(10, Math.ceil(duration / step))) : granularity === "hour" ? Math.min(24, Math.max(8, Math.ceil(duration / step))) : Math.min(365, Math.max(7, Math.ceil(duration / step)));
  const series = createSeries(count, step, Number.isFinite(end) && end > 0 ? end : FIXED_NOW);
  const totals = series.reduce((sum, bucket) => ({
    input: sum.input + bucket.input_tokens,
    cacheRead: sum.cacheRead + bucket.cache_read_tokens,
    cacheWrite: sum.cacheWrite + bucket.cache_write_tokens,
    output: sum.output + bucket.output_tokens,
  }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  const llmCalls = Math.max(12, Math.round(count * 5.4));

  return {
    metrics: {
      llm_calls: llmCalls,
      successful_calls: llmCalls - Math.max(1, Math.floor(llmCalls * 0.008)),
      failed_calls: Math.max(1, Math.floor(llmCalls * 0.008)),
      token_usage: totals.input + totals.cacheRead + totals.cacheWrite + totals.output,
      prompt_tokens: totals.input + totals.cacheRead + totals.cacheWrite,
      input_tokens: totals.input,
      cache_read_tokens: totals.cacheRead,
      cache_write_tokens: totals.cacheWrite,
      output_tokens: totals.output,
      estimated_cost_usd: (totals.input * 3 + totals.output * 15 + totals.cacheRead * 0.3 + totals.cacheWrite * 3.75) / 1_000_000,
      estimated_cache_cost_usd: (totals.cacheRead * 0.3 + totals.cacheWrite * 3.75) / 1_000_000,
      input_cost_usd: (totals.input * 3) / 1_000_000,
      output_cost_usd: (totals.output * 15) / 1_000_000,
      cache_read_cost_usd: (totals.cacheRead * 0.3) / 1_000_000,
      cache_write_cost_usd: (totals.cacheWrite * 3.75) / 1_000_000,
    },
    token_usage_granularity: granularity,
    token_usage_series: series,
  };
}

function createSeries(count: number, step: number, end: number): OverviewTokenUsageBucket[] {
  return Array.from({ length: count }, (_, index) => {
    const wave = 0.72 + ((index * 17) % 31) / 50;
    return {
      bucket_start_ms: end - (count - index) * step,
      // input : cache_read = 1 : 99，使默认口径缓存命中率恰为 99%
      input_tokens: Math.round(800 * wave),
      cache_read_tokens: Math.round(79_200 * wave),
      cache_write_tokens: Math.round(7_500 * wave),
      output_tokens: Math.round(12_500 * wave),
    };
  });
}

function createCallDetail(id: string): CallDetail {
  const call = calls.find((item) => item.call_id === decodeURIComponent(id)) ?? calls[0];
  return {
    call,
    request: {
      headers: { authorization: "Bearer sk-demo-••••", "content-type": "application/json" },
      body: { model: call.model_id, stream: true, messages: [{ role: "user", content: "Mock Agent request" }] },
      byte_count: 8_426,
    },
    response_chunks: [
      { seq: 1, received_offset_ms: 418, data: "event: response.created", byte_count: 128 },
      { seq: 2, received_offset_ms: 512, data: "event: response.output_text.delta", byte_count: 256 },
    ],
    cursor_trace: null,
  };
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (typeof raw !== "string" || raw.length === 0) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { return raw; }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function empty() {
  return new Response(null, { status: 204 });
}
