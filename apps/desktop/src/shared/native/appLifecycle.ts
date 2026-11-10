import { getVersion, setDockVisibility } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { api, type DesktopSettings } from "../api";
import { desktopPlatform } from "./platform";

export function hasNativeAppLifecycle(): boolean {
  return isTauri();
}

export function hasDockVisibilitySetting(): boolean {
  return hasNativeAppLifecycle() && desktopPlatform() === "macos";
}

export async function currentAppVersion(): Promise<string> {
  return hasNativeAppLifecycle() ? getVersion() : "dev";
}

export async function readAutostart(): Promise<boolean> {
  return isEnabled();
}

export async function writeAutostart(enabled: boolean): Promise<void> {
  await (enabled ? enable() : disable());
}

export async function readDesktopSettings(): Promise<DesktopSettings> {
  return api.desktopSettings();
}

export async function writeSilentStart(silentStart: boolean): Promise<void> {
  const settings = await readDesktopSettings();
  await api.setDesktopSettings({ ...settings, silent_start: silentStart });
}

export async function writeDockIconVisibility(visible: boolean): Promise<void> {
  const settings = await readDesktopSettings();
  await setDockVisibility(visible);
  try {
    await api.setDesktopSettings({ ...settings, show_dock_icon: visible });
  } catch (cause) {
    await setDockVisibility(settings.show_dock_icon).catch(() => {});
    throw cause;
  }
}

export type AppUpdate = {
  version: string;
  install(): Promise<void>;
  close(): Promise<void>;
};

export async function checkForUpdate(): Promise<AppUpdate | null> {
  const update: Update | null = await check();
  if (!update) return null;
  return {
    version: update.version,
    install: async () => {
      await update.downloadAndInstall();
      await relaunch();
    },
    close: () => update.close(),
  };
}

export async function installUpdate(update: AppUpdate): Promise<void> {
  await update.install();
}

export type ReleaseInfo = {
  version: string;
  tagName: string;
  name: string;
  publishedAt: string;
  body: string;
  prerelease: boolean;
};

export async function fetchReleaseHistory(): Promise<ReleaseInfo[]> {
  const response = await fetch("https://api.github.com/repos/root462/cursor-byok/releases?per_page=30", {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as Array<{
    tag_name: string;
    name: string | null;
    published_at: string;
    body: string | null;
    prerelease: boolean;
    draft: boolean;
  }>;
  return data
    .filter((r) => !r.draft && Boolean(r.tag_name))
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ""),
      tagName: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      body: r.body || "",
      prerelease: Boolean(r.prerelease),
    }));
}

export async function rollbackToVersion(version: string): Promise<void> {
  if (hasNativeAppLifecycle()) {
    await api.switchVersion(version);
    await relaunch();
  }
}

/**
 * The updater surfaces transport failures verbatim in English
 * ("Could not fetch a valid release JSON from the remote"), which tells the
 * user nothing actionable. Map the known unreachable-server shapes to a single
 * hint and keep every other message as-is.
 */
export function describeUpdateError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const unreachable = /release JSON|failed to fetch|network|dns|timed? ?out|timeout|connection|connect/i.test(raw);
  return unreachable
    ? t("无法连接更新服务器，请检查网络或代理后重试")
    : t("检查更新失败：{error}", { error: raw });
}
