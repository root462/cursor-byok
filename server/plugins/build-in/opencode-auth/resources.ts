import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceImportFile,
  ResourceImportResult,
  ResourceImportSupport,
  ResourceSnapshot,
  ResourceView,
} from "cursor-byok:resource";

export const RESOURCE_TYPE = "opencode-credential";
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

const ALLOWED_HOSTS = new Set([
  "opencode.ai",
  "api.opencode.ai",
  "zen.opencode.ai",
]);

export type OpenCodeCredential = {
  apiKey: string;
  baseUrl: string;
  displayName: string;
};

export type CredentialCandidate = {
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeApiKey(value: string): string {
  let key = stripQuotes(value.trim());
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, "").trim();
  if (!key || key.toLowerCase() === "guest" || key.toLowerCase() === "anonymous") {
    return "guest";
  }
  return key;
}

export function normalizeBaseUrl(value?: string | null): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid OpenCode endpoint: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenCode endpoint must use HTTPS or HTTP");
  }
  return url.toString().replace(/\/+$/, "");
}

function candidateFromRecord(raw: Record<string, unknown>): CredentialCandidate | null {
  // Check for OpenCode CLI auth.json format: { "zen": { "key": "..." } } or { "opencode": { "key": "..." } }
  for (const providerKey of ["zen", "opencode", "opencode-zen", "opencode-go"]) {
    const providerObj = record(raw[providerKey]);
    if (providerObj) {
      const apiKey = firstText(providerObj, ["key", "apiKey", "token", "api_key"]);
      if (apiKey) {
        return {
          apiKey,
          baseUrl: firstText(providerObj, ["baseUrl", "base_url", "url", "endpoint"]) ?? undefined,
          displayName: `OpenCode (${providerKey})`,
        };
      }
    }
  }

  const apiKey = firstText(raw, [
    "apiKey",
    "api_key",
    "key",
    "token",
    "OPENCODE_API_KEY",
    "OPENCODE_ZEN_API_KEY",
    "ZEN_API_KEY",
  ]);
  if (!apiKey) return null;

  return {
    apiKey,
    baseUrl: firstText(raw, ["baseUrl", "base_url", "url", "endpoint", "OPENCODE_BASE_URL"]) ?? undefined,
    displayName: firstText(raw, ["displayName", "display_name", "name", "email"]) ?? undefined,
  };
}

function parseEnv(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = stripQuotes(trimmed.slice(eq + 1));
    result[key] = value;
  }
  return result;
}

function collectCandidates(value: unknown, output: CredentialCandidate[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, output);
    return;
  }
  const source = record(value);
  if (!source) return;
  const direct = candidateFromRecord(source);
  if (direct) output.push(direct);
  for (const key of ["accounts", "credentials", "items", "data", "zen", "opencode"]) {
    if (key in source) collectCandidates(source[key], output);
  }
}

function candidatesFromFile(file: ResourceImportFile): CredentialCandidate[] {
  const raw = file.content.trim();
  if (!raw) return [];
  if (raw.startsWith("{") || raw.startsWith("[")) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const candidates: CredentialCandidate[] = [];
    collectCandidates(value, candidates);
    return candidates;
  }
  const env = parseEnv(raw);
  const envCandidate = candidateFromRecord(env);
  if (envCandidate) return [envCandidate];
  if (!raw.includes("\n") && !raw.includes("=") && !raw.includes(" ")) {
    return [{ apiKey: raw, displayName: file.name }];
  }
  return [];
}

async function credentialFingerprint(apiKey: string, baseUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${baseUrl}\n${apiKey}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function credentialDraft(
  candidate: CredentialCandidate,
): Promise<{ key: string; privateData: JsonValue }> {
  const apiKey = normalizeApiKey(candidate.apiKey);
  const baseUrl = normalizeBaseUrl(candidate.baseUrl);
  const displayName = candidate.displayName?.trim() ||
    (apiKey === "guest" ? "OpenCode 官方伪装协议" : `OpenCode · ${apiKey.slice(-4)}`);
  const data: OpenCodeCredential = {
    apiKey,
    baseUrl,
    displayName,
  };
  const key = await credentialFingerprint(apiKey, baseUrl);
  return {
    key,
    privateData: data as unknown as JsonValue,
  };
}

export function credentialData(resource: ResourceSnapshot): OpenCodeCredential {
  const raw = record(resource.privateData);
  if (!raw) throw new Error("corrupt OpenCode credential: privateData is not an object");
  const apiKey = text(raw.apiKey);
  if (!apiKey) throw new Error("corrupt OpenCode credential: missing apiKey");
  const baseUrl = normalizeBaseUrl(text(raw.baseUrl));
  const displayName = text(raw.displayName) || `OpenCode · ${apiKey.slice(-4)}`;
  return { apiKey, baseUrl, displayName };
}

export function presentCredential(resource: ResourceSnapshot): ResourceView {
  const data = credentialData(resource);
  const endpoint = new URL(data.baseUrl);
  return {
    displayName: data.displayName,
    description: {
      "en-US": `OpenCode Zen active · ${endpoint.host}`,
      "zh-CN": `OpenCode Zen 凭证已就绪 · ${endpoint.host}`,
    },
  };
}

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import OpenCode credentials",
    "zh-CN": "导入 OpenCode 凭证",
  },
  description: {
    "en-US":
      "Paste your OpenCode Zen API key, or import auth.json, .env, or a text file.",
    "zh-CN":
      "粘贴您的 OpenCode Zen API Key，或导入 auth.json、.env 凭证文件。",
  },
  accept: [".json", ".env", ".txt", ".key"],
  multiple: true,
  parse: async (
    files: ResourceImportFile[],
    _context: PluginContext,
  ): Promise<ResourceImportResult> => {
    const candidates: CredentialCandidate[] = [];
    const warnings: string[] = [];
    for (const file of files) {
      try {
        const found = candidatesFromFile(file);
        if (found.length === 0) {
          warnings.push(`${file.name}: no OpenCode credentials detected`);
        } else {
          candidates.push(...found);
        }
      } catch (error) {
        warnings.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (candidates.length === 0) {
      throw new Error(warnings.join("; ") || "credential file does not contain a valid OpenCode API key");
    }
    const resources = [];
    for (const candidate of candidates) {
      try {
        resources.push(await credentialDraft(candidate));
      } catch (error) {
        warnings.push(`${candidate.displayName ?? "credential"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (resources.length === 0) throw new Error(warnings.join("; "));
    return {
      resources,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
