import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import {
  accountData,
  fetchAccountProjectAndTier,
  isTokenExpired,
  refreshAccessToken,
} from "./resources.ts";

export const ANTIGRAVITY_PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  ANTIGRAVITY_SANDBOX_ENDPOINT,
];

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
export const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.26.0 (aidev_client; os_type=darwin; arch=arm64; cl=975423596)";

export const ANTIGRAVITY_CLIENT_HEADERS: Record<string, string> = {};

const ANTIGRAVITY_DENYLIST = new Set(["chat_20706", "chat_23310"]);

type KnownModelMetadata = {
  displayName: string;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  images?: boolean;
};

/**
 * 已知模型的展示名与能力元数据映射。
 * 仅用于补全上游 `/v1internal:fetchAvailableModels` 已返回但缺少 displayName 等字段的模型,
 * 不会把未出现在上游响应中的模型混入列表。
 */
const KNOWN_MODEL_METADATA: Record<string, KnownModelMetadata> = {
  "gemini-4-argon": {
    displayName: "Gemini 4 Argon",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-3.8-flash-high": {
    displayName: "Gemini 3.8 Flash (High)",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-3.8-flash-medium": {
    displayName: "Gemini 3.8 Flash (Medium)",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-3.8-flash-low": {
    displayName: "Gemini 3.8 Flash (Low)",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-3.8-flash-tiered": {
    displayName: "Gemini 3.8 Flash (Tiered)",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-3.7-flash": {
    displayName: "Gemini 3.7 Flash",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-3.7-flash-high": { displayName: "Gemini 3.7 Flash (High)" },
  "gemini-3.7-flash-medium": { displayName: "Gemini 3.7 Flash (Medium)" },
  "gemini-3.7-flash-low": { displayName: "Gemini 3.7 Flash (Low)" },
  "gemini-3.7-flash-tiered": { displayName: "Gemini 3.7 Flash (Tiered)" },
  "gemini-3.7-flash-thinking": { displayName: "Gemini 3.7 Flash (Thinking)" },
  "gemini-3.6-flash-high": { displayName: "Gemini 3.6 Flash (High)" },
  "gemini-3.6-flash-medium": { displayName: "Gemini 3.6 Flash (Medium)" },
  "gemini-3.6-flash-low": { displayName: "Gemini 3.6 Flash (Low)" },
  "gemini-3.1-pro-preview": {
    displayName: "Gemini 3.1 Pro Preview",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)" },
  "gemini-3.1-pro-medium": { displayName: "Gemini 3.1 Pro (Medium)" },
  "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro (Low)" },
  "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" },
  "gemini-2.5-pro": {
    displayName: "Gemini 2.5 Pro",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-2.5-flash": {
    displayName: "Gemini 2.5 Flash",
    reasoningEfforts: ["low", "medium", "high"],
  },
  "gemini-2.5-flash-thinking": { displayName: "Gemini 2.5 Flash Thinking" },
  "gemini-2.5-flash-lite": { displayName: "Gemini 2.5 Flash Lite" },
  "gemini-2.0-flash": { displayName: "Gemini 2.0 Flash" },
  "gemini-2.0-flash-lite": { displayName: "Gemini 2.0 Flash Lite" },
  "claude-sonnet-4-6": {
    displayName: "Claude Sonnet 4.6",
    maxOutputTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  "claude-sonnet-4-6-thinking": {
    displayName: "Claude Sonnet 4.6 Thinking",
    maxOutputTokens: 64000,
  },
  "claude-opus-4-6-thinking": {
    displayName: "Claude Opus 4.6 Thinking",
    maxOutputTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  "claude-sonnet-4-5": {
    displayName: "Claude Sonnet 4.5",
    maxOutputTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  "claude-sonnet-4-5-thinking": {
    displayName: "Claude Sonnet 4.5 Thinking",
    maxOutputTokens: 64000,
  },
  "claude-opus-4-5-thinking": {
    displayName: "Claude Opus 4.5 Thinking",
    maxOutputTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  "claude-3-7-sonnet": {
    displayName: "Claude 3.7 Sonnet",
    maxOutputTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  "claude-3-5-sonnet": {
    displayName: "Claude 3.5 Sonnet",
    maxOutputTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  "claude-3-5-haiku": {
    displayName: "Claude 3.5 Haiku",
    maxOutputTokens: 64000,
  },
  "gpt-oss-120b-medium": {
    displayName: "GPT OSS 120B Medium",
    maxOutputTokens: 32768,
    images: false,
  },
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatModelDisplayName(id: string): string {
  return id
    .split("-")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt" || lower === "oss") return lower.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

const EFFORT_ORDER = ["low", "medium", "high", "tiered"] as const;
const ID_EFFORT_SUFFIX_RE = /-(low|medium|high|tiered)$/i;
const DISPLAY_EFFORT_SUFFIX_RE = /\s*\((low|medium|high|tiered)\)$/i;

function splitEffortVariant(
  id: string,
  rawDisplayName: string | null,
): { baseId: string; baseDisplayName: string; effortTier: string | null } {
  const idMatch = id.match(ID_EFFORT_SUFFIX_RE);
  const displayMatch = rawDisplayName?.match(DISPLAY_EFFORT_SUFFIX_RE) ?? null;
  const effortTier = (idMatch?.[1] ?? displayMatch?.[1])?.toLowerCase() ?? null;
  const baseId = idMatch ? id.slice(0, -idMatch[0].length) : id;
  const known = KNOWN_MODEL_METADATA[baseId] ?? KNOWN_MODEL_METADATA[id];
  const fallbackName = rawDisplayName ?? known?.displayName ?? formatModelDisplayName(baseId);
  const baseDisplayName = fallbackName.replace(DISPLAY_EFFORT_SUFFIX_RE, "").trim() || fallbackName;
  return { baseId, baseDisplayName, effortTier };
}

function slugifyDisplayName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function orderEfforts(efforts: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const effort of efforts) {
    const lower = effort.trim().toLowerCase();
    if (lower) set.add(lower);
  }
  const ordered: string[] = [];
  for (const tier of EFFORT_ORDER) {
    if (set.delete(tier)) ordered.push(tier);
  }
  for (const rest of set) {
    ordered.push(rest);
  }
  return ordered;
}

export function parseAntigravityModels(payload: unknown): ModelDefinition[] {
  const root = object(payload);
  const modelsMap = object(root?.models);
  const agentModelsMap = object(root?.agentModels);
  if (!modelsMap && !agentModelsMap) return [];
  const rawModels: Record<string, unknown> = {
    ...(agentModelsMap ?? {}),
    ...(modelsMap ?? {}),
  };

  type ConsolidatedGroup = {
    baseId: string;
    displayName: string;
    description: string | null;
    supportsImages: boolean;
    maxOutputTokens: number;
    efforts: Set<string>;
    effortModelMap: Record<string, string>;
  };

  const groups = new Map<string, ConsolidatedGroup>();
  const seenRawIds = new Set<string>();

  for (const [modelId, raw] of Object.entries(rawModels)) {
    const id = modelId.trim();
    if (!id || seenRawIds.has(id) || ANTIGRAVITY_DENYLIST.has(id)) continue;
    if (id.startsWith("tab_")) continue;

    const model = object(raw);
    // 注意：不要过滤 model.isInternal === true，否则 Gemini 4 Argon 等内部代号/前沿模型会被过滤掉
    if (!model || model.disabled === true) continue;
    seenRawIds.add(id);

    const rawDisplayName = text(model.displayName ?? model.display_name ?? model.title);
    const { baseId, baseDisplayName, effortTier } = splitEffortVariant(id, rawDisplayName);
    const known = KNOWN_MODEL_METADATA[baseId] ?? KNOWN_MODEL_METADATA[id];
    const description = text(model.description);
    const baseEfforts = typeof model.supportsThinking === "boolean"
      ? (model.supportsThinking ? ["low", "medium", "high"] : [])
      : (known?.reasoningEfforts ?? []);
    const maxOutputTokens = typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0
      ? model.maxOutputTokens
      : (known?.maxOutputTokens ?? 65_536);
    const supportsImages = typeof model.supportsImages === "boolean"
      ? model.supportsImages
      : (known?.images ??
        (baseId.includes("gemini") || baseId.includes("claude") || baseId.includes("image")));

    const groupKey = baseDisplayName.toLowerCase();
    const existing = groups.get(groupKey);
    const preferredSlug = slugifyDisplayName(baseDisplayName);

    if (!existing) {
      const efforts = new Set<string>(baseEfforts);
      const effortModelMap: Record<string, string> = {};
      if (effortTier) {
        efforts.add(effortTier);
        effortModelMap[effortTier] = id;
      }
      groups.set(groupKey, {
        baseId,
        displayName: baseDisplayName,
        description,
        supportsImages,
        maxOutputTokens,
        efforts,
        effortModelMap,
      });
    } else {
      if (baseId.toLowerCase() === preferredSlug && existing.baseId.toLowerCase() !== preferredSlug) {
        existing.baseId = baseId;
      }
      if (!existing.description && description) {
        existing.description = description;
      }
      existing.maxOutputTokens = Math.max(existing.maxOutputTokens, maxOutputTokens);
      existing.supportsImages = existing.supportsImages || supportsImages;
      for (const item of baseEfforts) existing.efforts.add(item);
      if (effortTier) {
        existing.efforts.add(effortTier);
        existing.effortModelMap[effortTier] = id;
      }
    }
  }

  const models: ModelDefinition[] = [];
  for (const group of groups.values()) {
    const mapKeys = Object.keys(group.effortModelMap);
    // 若模型是由多个档位（如 -low / -medium / -high / -tiered）聚合而来，只暴露实际支持或上游声明的档位
    const reasoningEfforts = mapKeys.length > 1
      ? orderEfforts(mapKeys)
      : orderEfforts(group.efforts);

    models.push({
      id: group.baseId,
      displayName: group.displayName,
      ...(group.description ? { description: group.description } : {}),
      capabilities: {
        images: group.supportsImages,
      },
      maxOutputTokens: group.maxOutputTokens,
      privateData: {
        reasoningEfforts,
        ...(mapKeys.length > 0 ? { effortModelMap: group.effortModelMap } : {}),
      },
    });
  }

  return models;
}

export function reasoningEfforts(model: ModelSnapshot): string[] {
  const data = object(model.privateData);
  const efforts = data?.reasoningEfforts;
  return Array.isArray(efforts) ? efforts.filter((item) => typeof item === "string") : [];
}

export function resolveModelVariantId(
  model: ModelSnapshot,
  requestedEffort: string | null | undefined,
): string {
  const data = object(model.privateData);
  const rawMap = object(data?.effortModelMap);
  if (rawMap) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawMap)) {
      if (typeof v === "string" && v.trim()) {
        map[k.toLowerCase()] = v.trim();
      }
    }
    const rawEffort = requestedEffort?.trim().toLowerCase() ?? null;
    const normalizedEffort = rawEffort === "minimal"
      ? "low"
      : rawEffort === "xhigh"
      ? "high"
      : rawEffort;
    if (normalizedEffort && map[normalizedEffort]) {
      return map[normalizedEffort];
    }
    return map.high ?? map.medium ?? map.low ?? map.tiered ?? Object.values(map)[0] ?? model.id;
  }
  return model.id;
}

async function fetchModelsOnce(
  accessToken: string,
  projectId: string,
  network: Parameters<ModelSupport["list"]>[1]["network"],
): Promise<{ models: ModelDefinition[]; unauthorized: boolean; lastStatus: number | null }> {
  const payloads = [
    JSON.stringify({ project: projectId }),
    JSON.stringify({}),
  ];
  let unauthorized = false;
  let lastStatus: number | null = null;
  const mergedModels: Record<string, unknown> = {};
  let hasAnySuccess = false;

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    let endpointSucceeded = false;
    for (const bodyPayload of payloads) {
      try {
        const response = await network.fetch(
          `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
              accept: "application/json",
              "user-agent": ANTIGRAVITY_USER_AGENT,
              ...ANTIGRAVITY_CLIENT_HEADERS,
            },
            body: bodyPayload,
          },
        );
        lastStatus = response.status;
        if (response.status === 401 || response.status === 403) {
          unauthorized = true;
          continue;
        }
        if (response.status >= 200 && response.status < 300) {
          const body = object(JSON.parse(response.body));
          const rawModels = {
            ...(object(body?.agentModels) ?? {}),
            ...(object(body?.models) ?? {}),
          };
          if (Object.keys(rawModels).length > 0) {
            for (const [k, v] of Object.entries(rawModels)) {
              if (!(k in mergedModels)) {
                mergedModels[k] = v;
              }
            }
            hasAnySuccess = true;
            endpointSucceeded = true;
            break;
          }
        }
      } catch {
        // Try next endpoint
      }
    }
    // 合并 daily 与 prod 两个主端点的可用模型（部分前沿模型如 Gemini 4 Argon 只在特定端点下发）
    if (endpointSucceeded && endpoint === ANTIGRAVITY_PROD_ENDPOINT) {
      break;
    }
  }

  if (hasAnySuccess) {
    const models = parseAntigravityModels({ models: mergedModels });
    if (models.length > 0) {
      return { models, unauthorized: false, lastStatus };
    }
  }

  return { models: [], unauthorized, lastStatus };
}

export const antigravityModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) {
      throw new Error("add a Google account before syncing Antigravity models");
    }
    const data = accountData(resource);
    let accessToken = data.accessToken;
    let refreshed = false;

    if (data.refreshToken && isTokenExpired(data)) {
      const tokenResult = await refreshAccessToken(data.refreshToken, context.network);
      if (tokenResult.ok) {
        accessToken = tokenResult.accessToken;
        refreshed = true;
      }
    }

    let projectId = data.projectId || "bamboo-precept-lgxtn";
    if (!data.projectId || data.projectId === "bamboo-precept-lgxtn") {
      try {
        const tier = await fetchAccountProjectAndTier(accessToken, context.network);
        projectId = tier.projectId || projectId;
      } catch {
        // Keep fallback projectId
      }
    }

    let attempt = await fetchModelsOnce(accessToken, projectId, context.network);
    if (attempt.models.length === 0 && attempt.unauthorized && data.refreshToken && !refreshed) {
      const tokenResult = await refreshAccessToken(data.refreshToken, context.network);
      if (tokenResult.ok) {
        accessToken = tokenResult.accessToken;
        attempt = await fetchModelsOnce(accessToken, projectId, context.network);
      }
    }

    if (attempt.models.length === 0) {
      const statusDetail = attempt.lastStatus !== null ? ` (HTTP ${attempt.lastStatus})` : "";
      throw new Error(`Antigravity model discovery returned no available models${statusDetail}`);
    }

    return attempt.models;
  },
};
