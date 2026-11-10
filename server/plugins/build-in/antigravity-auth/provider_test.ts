import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import {
  antigravityModels,
  parseAntigravityModels,
  resolveModelVariantId,
} from "./models.ts";
import { antigravityProvider, isQuotaError } from "./provider.ts";
import { RESOURCE_TYPE } from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: RequestInit) => NetworkResponse;
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;

function context(handlers: { fetch?: FetchHandler; stream?: StreamHandler }): PluginContext {
  return {
    network: {
      fetch: (url, init) => {
        if (!handlers.fetch) throw new Error("fetch was not expected");
        return Promise.resolve(handlers.fetch(url, init));
      },
      stream: (url, init) => {
        if (!handlers.stream) throw new Error("stream was not expected");
        return Promise.resolve(handlers.stream(url, init));
      },
    },
    signal: new AbortController().signal,
  };
}

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "antigravity:user-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are an AI coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "standard",
    maxOutputTokens: 65536,
    cacheKey: "conv-1",
  };
}

Deno.test("provider parses usage metadata including cachedContentTokenCount as cacheReadTokens", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];

  const result = await antigravityProvider.invoke(
    {
      model: {
        id: "gemini-3.7-flash-medium",
        displayName: "Gemini 3.7 Flash Medium",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assert(url.includes("/v1internal:streamGenerateContent?alt=sse"));
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":15,"totalTokenCount":135,"cachedContentTokenCount":80}}}',
          ]),
        };
      },
    }),
  );

  assertEquals(result, { status: "completed" });
  assertEquals(requestHeaders["authorization"], "Bearer mock-access-token");
  assertEquals(requestHeaders.accept, "text/event-stream");
  assert(!("session-id" in requestHeaders), "Codex-only session-id header was sent");
  assert(!("thread-id" in requestHeaders), "Codex-only thread-id header was sent");
  assert(!("x-client-request-id" in requestHeaders), "request-id header was reused as cache key");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.project, "test-project-123");
  assertEquals(body.model, "gemini-3.7-flash-medium");
  assert(!("sessionId" in body), "unsupported sessionId field was sent");
  assert(!("conversationId" in body), "unsupported conversationId field was sent");

  assertEquals(events, [
    { type: "thinking-start" },
    { type: "thinking-delta", text: "Thinking..." },
    { type: "thinking-end" },
    { type: "text-start" },
    { type: "text-delta", text: "Hello world" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 15,
        totalTokens: 135,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("isQuotaError identifies rate limits and quota exhaustion", () => {
  assert(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded"));
  assert(isQuotaError("Rate limit exceeded for model"));
  assert(isQuotaError("HTTP 429 Too Many Requests"));
  assert(!isQuotaError("Invalid authorization header"));
});

Deno.test("parseAntigravityModels only includes models returned by upstream and filters denylist", () => {
  const models = parseAntigravityModels({
    models: {
      "gemini-2.5-pro": {
        quotaInfo: { remainingFraction: 1 },
      },
      "claude-sonnet-4-6": {
        displayName: "Claude Sonnet 4.6",
        supportsThinking: true,
        maxOutputTokens: 64000,
      },
      "gemini-4-argon": {
        displayName: "Gemini 4 Argon",
        isInternal: true,
        supportsThinking: true,
      },
      "chat_20706": {
        displayName: "Internal Chat",
      },
      "tab_flash_lite_preview": {
        displayName: "Tab Model",
      },
    },
  });

  assertEquals(models.map((m) => m.id), ["gemini-2.5-pro", "claude-sonnet-4-6", "gemini-4-argon"]);
  assertEquals(models[0].displayName, "Gemini 2.5 Pro");
  assertEquals(models[1].displayName, "Claude Sonnet 4.6");
  assertEquals(models[2].displayName, "Gemini 4 Argon");
});

Deno.test("parseAntigravityModels consolidates effort variants and deduplicates alias display names", () => {
  const models = parseAntigravityModels({
    models: {
      "claude-opus-5-5-low": {
        displayName: "Claude Opus 5.5 (Low)",
        supportsThinking: true,
        maxOutputTokens: 128000,
      },
      "claude-opus-5-5-medium": {
        displayName: "Claude Opus 5.5 (Medium)",
        supportsThinking: true,
        maxOutputTokens: 128000,
      },
      "claude-opus-5-5-high": {
        displayName: "Claude Opus 5.5 (High)",
        supportsThinking: true,
        maxOutputTokens: 128000,
      },
      "gemini-2.5-flash": {
        displayName: "Gemini 3.5 Flash Lite",
        supportsThinking: true,
      },
      "gemini-3.5-flash-lite": {
        displayName: "Gemini 3.5 Flash Lite",
        supportsThinking: true,
      },
    },
  });

  assertEquals(models.map((m) => m.id), ["claude-opus-5-5", "gemini-3.5-flash-lite"]);
  assertEquals(models[0].displayName, "Claude Opus 5.5");
  assertEquals(resolveModelVariantId(models[0], "low"), "claude-opus-5-5-low");
  assertEquals(resolveModelVariantId(models[0], "medium"), "claude-opus-5-5-medium");
  assertEquals(resolveModelVariantId(models[0], "high"), "claude-opus-5-5-high");
  assertEquals(resolveModelVariantId(models[0], null), "claude-opus-5-5-high");
  assertEquals(models[1].displayName, "Gemini 3.5 Flash Lite");
});

Deno.test("antigravityModels.list refreshes expired token and returns only discovered models", async () => {
  const calls: string[] = [];
  const models = await antigravityModels.list(
    {
      resource: snapshot({
        accessToken: "expired-token",
        refreshToken: "valid-refresh-token",
        expiresAtMs: Date.now() - 10_000,
        projectId: "proj-123",
      }),
    },
    context({
      fetch: (url, init) => {
        calls.push(url);
        if (url === "https://oauth2.googleapis.com/token") {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              access_token: "fresh-token",
              expires_in: 3600,
            }),
          };
        }
        assertEquals(init?.headers?.["authorization"], "Bearer fresh-token");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            models: {
              "gemini-2.5-flash": {
                quotaInfo: { remainingFraction: 0.99 },
              },
            },
          }),
        };
      },
    }),
  );

  assertEquals(calls[0], "https://oauth2.googleapis.com/token");
  assertEquals(models.map((m) => m.id), ["gemini-2.5-flash"]);
});
