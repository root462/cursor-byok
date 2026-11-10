import type { OpenCodeCredential } from "./resources.ts";

const OPENCODE_VERSION = "1.2.14";
const FALLBACK_NODE_MAJOR = "22";
const STAINLESS_PREFIX = "x-stainless-";

type RuntimeInfo = {
  category: "macos" | "windows" | "linux";
  arch: string;
  osVersion: string;
};

function denoBuild(): { os?: string; arch?: string } | null {
  return (globalThis as { Deno?: { build?: { os?: string; arch?: string } } }).Deno?.build ??
    null;
}

function osRelease(): string | null {
  const release = (globalThis as { Deno?: { osRelease?: () => string } }).Deno?.osRelease;
  if (typeof release !== "function") return null;
  try {
    return release.call(undefined) || null;
  } catch {
    return null;
  }
}

function runtimeInfo(): RuntimeInfo {
  const build = denoBuild();
  const os = build?.os ?? "linux";
  const rawArch = build?.arch ?? "x86_64";
  const category = os === "darwin" ? "macos" : os === "windows" ? "windows" : "linux";
  const arch = rawArch === "x86_64"
    ? "x64"
    : rawArch === "aarch64" || rawArch === "arm64"
    ? "arm64"
    : rawArch;
  return {
    category,
    arch,
    osVersion: osRelease() ?? "unknown",
  };
}

export function opencodeIdentityHeaders(
  data: OpenCodeCredential,
  session?: string,
): Record<string, string> {
  const platform = runtimeInfo();
  const sessionId = session ?? crypto.randomUUID();
  const requestId = crypto.randomUUID();

  const headers: Record<string, string> = {
    "User-Agent": `opencode/${OPENCODE_VERSION} runtime/node.js/${FALLBACK_NODE_MAJOR} (${platform.category}-${platform.arch})`,
    "x-opencode-version": OPENCODE_VERSION,
    "x-opencode-client": "cli",
    "x-opencode-session-id": sessionId,
    "x-client-name": "opencode",
    "x-client-version": OPENCODE_VERSION,
    "x-session-id": sessionId,
    "x-request-id": requestId,
  };

  if (data.apiKey && data.apiKey !== "guest" && data.apiKey !== "anonymous") {
    headers["Authorization"] = `Bearer ${data.apiKey}`;
  }

  return headers;
}

export function stripSdkFingerprintHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !key.toLowerCase().startsWith(STAINLESS_PREFIX)),
  );
}

export function opencodeRequestHeaders(
  base: Record<string, string>,
  data: OpenCodeCredential,
  session?: string,
): Record<string, string> {
  return {
    ...stripSdkFingerprintHeaders(base),
    ...opencodeIdentityHeaders(data, session),
  };
}
