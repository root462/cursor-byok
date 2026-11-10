/**
 * OpenCode client environment spoofing.
 *
 * Simulates the official OpenCode CLI runtime headers for calling OpenCode
 * Zen / Go endpoints with official client identity.
 */

export const OPENCODE_PLUGIN_ID = "dev.cursorbyok.plugins.opencode-auth";
const OPENCODE_VERSION = "1.2.14";

export type OpencodeEnvironment = {
  customHeaders: Record<string, string>;
  openaiExtraParams: Record<string, unknown>;
};

export function opencodeEnvironment(): OpencodeEnvironment {
  return {
    customHeaders: {
      "User-Agent": `opencode/${OPENCODE_VERSION} runtime/node.js/22 ({{OsPlatform}})`,
      "x-opencode-version": OPENCODE_VERSION,
      "x-opencode-client": "cli",
      "x-opencode-session-id": "{{SessionId}}",
      "x-client-name": "opencode",
      "x-client-version": OPENCODE_VERSION,
      "x-session-id": "{{SessionId}}",
      "x-request-id": "{{Uuid}}",
    },
    openaiExtraParams: {},
  };
}

export function usesOpencodeEnvironment(customHeaders: Record<string, unknown>): boolean {
  return Object.keys(customHeaders).some(
    (name) => name.toLowerCase() === "x-opencode-client" || name.toLowerCase() === "x-opencode-version",
  );
}

export function isOpencodePluginReady(
  plugins: { id: string; providers: { configured: boolean; models: { enabled: boolean }[] }[] }[],
): boolean {
  const plugin = plugins.find((candidate) => candidate.id === OPENCODE_PLUGIN_ID);
  if (!plugin) return false;
  return plugin.providers.some(
    (provider) => provider.configured && provider.models.some((model) => model.enabled),
  );
}
