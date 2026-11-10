import type { PluginContext } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { credentialData } from "./resources.ts";

const MODEL_CAPABILITY_IMAGES = "images";
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

type RawModel = {
  id: string;
  displayName: string;
  description?: string;
  maxOutputTokens?: number;
  images: boolean;
};

const FALLBACK_MODELS: RawModel[] = [
  { id: "claude-3-7-sonnet", displayName: "Claude 3.7 Sonnet", images: true, maxOutputTokens: 64_000 },
  { id: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet", images: true, maxOutputTokens: 8_192 },
  { id: "gpt-4o", displayName: "GPT-4o", images: true, maxOutputTokens: 16_384 },
  { id: "o3-mini", displayName: "o3-mini", images: false, maxOutputTokens: 65_536 },
  { id: "deepseek-chat", displayName: "DeepSeek V3", images: false, maxOutputTokens: 8_192 },
  { id: "deepseek-reasoner", displayName: "DeepSeek R1", images: false, maxOutputTokens: 8_192 },
  { id: "qwen-2.5-coder-32b", displayName: "Qwen 2.5 Coder 32B", images: false, maxOutputTokens: 8_192 },
  { id: "glm-4-plus", displayName: "GLM-4 Plus", images: false, maxOutputTokens: 4_096 },
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function parseModelsResponse(body: unknown): ModelDefinition[] {
  const root = record(body);
  const source = Array.isArray(body)
    ? body
    : Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
    ? root.models
    : null;
  if (!source) {
    throw new Error("OpenCode model discovery response does not contain a model list");
  }
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const item of source) {
    const raw = typeof item === "string" ? { id: item } : record(item);
    if (!raw) continue;
    const id = text(raw.id ?? raw.model ?? raw.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = text(raw.display_name ?? raw.displayName ?? raw.name) ?? id;
    const description = text(raw.description);
    const maxOutputTokens = positiveInteger(
      raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.max_completion_tokens,
    );
    const isVision = /vision|image|4o|sonnet|opus|gemini/i.test(id);
    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { images: isVision },
    });
  }
  return models;
}

function fallbackModels(): ModelDefinition[] {
  return FALLBACK_MODELS.map((item) => ({
    id: item.id,
    displayName: item.displayName,
    ...(item.description ? { description: item.description } : {}),
    maxOutputTokens: item.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    capabilities: { images: item.images },
  }));
}

export const opencodeModels: ModelSupport = {
  list: async ({ resource }, context: PluginContext): Promise<ModelDefinition[]> => {
    if (!resource) return fallbackModels();
    const data = credentialData(resource);
    const url = `${data.baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const response = await context.network.fetch(url, {
        headers: {
          authorization: `Bearer ${data.apiKey}`,
          "content-type": "application/json",
        },
      });
      if (response.status >= 200 && response.status < 300) {
        const body = JSON.parse(response.body);
        const discovered = parseModelsResponse(body);
        if (discovered.length > 0) return discovered;
      }
    } catch {
      // Fallback to static catalog if remote discovery fails
    }

    return fallbackModels();
  },
};
