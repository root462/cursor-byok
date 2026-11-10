import type { PluginContext } from "cursor-byok:plugin";
import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { opencodeModels } from "./models.ts";
import { opencodeRequestHeaders } from "./headers.ts";
import { credentialData, RESOURCE_TYPE, type OpenCodeCredential } from "./resources.ts";

function isQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("insufficient_quota") ||
    lower.includes("quota_exceeded") ||
    lower.includes("usage_limit") ||
    lower.includes("rate limit") ||
    lower.includes("payment_required") ||
    lower.includes("429");
}

function quotaPatch(message: string) {
  return {
    state: {
      status: "cooling" as const,
      retryAtMs: Date.now() + 60_000,
      message,
    },
  };
}

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add an OpenCode credential before calling OpenCode" };
  }
  let data: OpenCodeCredential;
  try {
    data = credentialData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }

  const url = `${data.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  const headers = opencodeRequestHeaders(baseHeaders, data, input.request.cacheKey ?? undefined);

  try {
    await streamOpenAiChat(
      {
        url,
        model: input.model.id,
        request: input.request,
        headers,
      },
      output,
      context,
    );
    return { status: "completed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError) {
      if (error.status === 401) {
        return invalidResult(message, "OpenCode API key is invalid or expired");
      }
      if (error.status === 402 || error.status === 429 || isQuotaError(message)) {
        return {
          status: "resource-error",
          message,
          patch: quotaPatch(message),
        };
      }
    }
    return { status: "request-error", message };
  }
}

export const opencodeProvider: ProviderSupport = {
  id: "opencode",
  displayName: {
    "en-US": "OpenCode Zen",
    "zh-CN": "OpenCode Zen",
  },
  description: {
    "en-US": "Access Claude, GPT, DeepSeek, and Qwen coding models through OpenCode Zen / Go.",
    "zh-CN": "通过 OpenCode Zen / Go 访问 Claude、GPT、DeepSeek 与 Qwen 等编程模型。",
  },
  providerType: "openai",
  resourceType: RESOURCE_TYPE,
  models: opencodeModels,
  invoke,
};
