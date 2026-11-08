#!/usr/bin/env node
/**
 * Thin wrapper around the Tauri CLI that forwards every argument unchanged and
 * optionally injects an updater endpoint override.
 *
 * The updater reads its endpoints from `tauri.conf.json`, so pointing a build at
 * a mirror without editing the committed config requires a config overlay.
 * `CURSOR_BYOK_UPDATER_ENDPOINTS` accepts a comma-separated list, in priority
 * order; the first entry that answers wins and the rest act as fallbacks.
 *
 *   CURSOR_BYOK_UPDATER_ENDPOINTS="https://mirror.example.com/latest.json" \
 *     npm run tauri:build
 *
 * Without the variable the wrapper is a pure pass-through, so the committed
 * GitHub endpoint stays the default.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_NAME = "CURSOR_BYOK_UPDATER_ENDPOINTS";

function endpointOverlay() {
  const endpoints = (process.env[ENV_NAME] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (endpoints.length === 0) return null;
  const directory = mkdtempSync(join(tmpdir(), "byok-updater-"));
  const path = join(directory, "tauri.updater.conf.json");
  writeFileSync(path, `${JSON.stringify({ plugins: { updater: { endpoints } } }, null, 2)}\n`);
  return { path, endpoints };
}

const args = process.argv.slice(2);
const overlay = endpointOverlay();
if (overlay) {
  args.push("--config", overlay.path);
  console.log(`[updater] endpoints -> ${overlay.endpoints.join(", ")}`);
}

const binary = join("node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const result = spawnSync(binary, args, { stdio: "inherit", shell: process.platform === "win32" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
