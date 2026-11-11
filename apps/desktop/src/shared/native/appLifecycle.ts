import { getVersion, setDockVisibility } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { api, type DesktopSettings, type ReleaseInfo } from "../api";
import { desktopPlatform } from "./platform";

export type { ReleaseInfo } from "../api";

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

export async function fetchReleaseHistory(): Promise<ReleaseInfo[]> {
  return api.releaseHistory();
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
  const unreachable = /release JSON|failed to fetch|load failed|network|dns|timed? ?out|timeout|connection|connect/i.test(raw);
  return unreachable
    ? t("无法连接更新服务器，请检查网络或代理后重试")
    : t("检查更新失败：{error}", { error: raw });
}
