#!/usr/bin/env node
/**
 * Seeds the Tauri bundler tool cache before `tauri build` runs.
 *
 * The bundler downloads a few helper binaries from
 * `github.com/<owner>/<repo>/releases/download/...` on first use and does not
 * retry. When that endpoint answers 504 the whole bundle step fails even though
 * the Rust build already succeeded:
 *
 *   Downloading .../nsis-3.11.zip          -> failed to bundle project: http status: 504
 *   Downloading .../apprun-old/AppRun-x86_64 -> failed to bundle project: http status: 504
 *
 * `api.github.com` asset downloads still work in that situation, so this script
 * fetches the same bytes through the API and drops them where the bundler
 * expects to find them. `tauri-bundler` only reaches the network when a cached
 * file is missing, so a successful seed skips the broken download entirely.
 *
 * Every item is best effort: a failure is logged and the build continues with
 * the normal download path, which keeps this step harmless once GitHub recovers.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import https from "node:https";

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const USER_AGENT = "cursor-byok-release-seeder";

/** Mirrors `dirs::cache_dir().join("tauri")` in tauri-bundler. */
function cacheRoot() {
  const override = process.argv.find((arg) => arg.startsWith("--cache="));
  if (override) return override.slice("--cache=".length);
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "tauri");
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "tauri");
}

function fetchUrl(url, accept, depth = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = { "user-agent": USER_AGENT, accept: accept || "*/*" };
    // Release asset downloads redirect to blob storage, which rejects the token.
    if (TOKEN && target.hostname === "api.github.com") headers.authorization = `Bearer ${TOKEN}`;

    const request = https.get(target, { headers, timeout: 180_000 }, (response) => {
      const { statusCode, headers: responseHeaders } = response;
      if ([301, 302, 303, 307, 308].includes(statusCode) && responseHeaders.location) {
        response.resume();
        if (depth >= 6) {
          reject(new Error(`too many redirects for ${url}`));
          return;
        }
        const next = new URL(responseHeaders.location, url).toString();
        fetchUrl(next, accept, depth + 1).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`timeout for ${url}`)));
    request.on("error", reject);
  });
}

async function fetchReleaseAsset(owner, repo, tag, asset) {
  const release = JSON.parse(
    (await fetchUrl(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, "application/vnd.github+json")).toString(),
  );
  const match = (release.assets || []).find((item) => item.name === asset);
  if (!match) throw new Error(`asset ${asset} missing from ${owner}/${repo}@${tag}`);
  return fetchUrl(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${match.id}`, "application/octet-stream");
}

/** Minimal zip reader: enough for the NSIS toolset archive (deflate or stored). */
function extractZip(buffer, destination) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive");

  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let written = 0;

  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written += 1;
  }
  return written;
}

function sha1(path) {
  return createHash("sha1").update(readFileSync(path)).digest("hex").toUpperCase();
}

function describe(path) {
  const size = statSync(path).size;
  return `${path} (${(size / 1024).toFixed(0)} KiB)`;
}

async function saveAsset({ owner, repo, tag, asset, target, executable = false }) {
  if (existsSync(target)) {
    console.log(`skip   ${describe(target)}`);
    return true;
  }
  const data = await fetchReleaseAsset(owner, repo, tag, asset);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  if (executable) chmodSync(target, 0o755);
  console.log(`seeded ${describe(target)}`);
  return true;
}

async function seedLinux(root) {
  const jobs = [
    { owner: "tauri-apps", repo: "binary-releases", tag: "apprun-old", asset: "AppRun-x86_64", target: join(root, "AppRun-x86_64"), executable: true },
    { owner: "tauri-apps", repo: "binary-releases", tag: "linuxdeploy", asset: "linuxdeploy-x86_64.AppImage", target: join(root, "linuxdeploy-x86_64.AppImage"), executable: true },
    { owner: "linuxdeploy", repo: "linuxdeploy-plugin-appimage", tag: "continuous", asset: "linuxdeploy-plugin-appimage-x86_64.AppImage", target: join(root, "linuxdeploy-plugin-appimage.AppImage"), executable: true },
  ];
  let ok = true;
  for (const job of jobs) {
    try {
      await saveAsset(job);
    } catch (cause) {
      ok = false;
      console.warn(`warn   ${job.asset}: ${cause.message}`);
    }
  }

  // These two are small scripts served by raw.githubusercontent.com, which is
  // usually reachable; seed them too so a cold cache needs no network at all.
  for (const [asset, source] of [
    ["linuxdeploy-plugin-gtk.sh", "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh"],
    ["linuxdeploy-plugin-gstreamer.sh", "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh"],
  ]) {
    const target = join(root, asset);
    if (existsSync(target)) {
      console.log(`skip   ${describe(target)}`);
      continue;
    }
    try {
      const data = await fetchUrl(source, "*/*");
      writeFileSync(target, data);
      chmodSync(target, 0o755);
      console.log(`seeded ${describe(target)}`);
    } catch (cause) {
      console.warn(`warn   ${asset}: ${cause.message}`);
    }
  }
  return ok;
}

const NSIS_DIR = "NSIS";
const NSIS_ZIP_FOLDER = "nsis-3.11";

async function seedWindows(root) {
  const nsisRoot = join(root, NSIS_DIR);
  let ok = true;

  if (!existsSync(join(nsisRoot, "makensis.exe"))) {
    try {
      console.log("fetch  nsis-3.11.zip via api");
      const archive = await fetchReleaseAsset("tauri-apps", "binary-releases", "nsis-3.11", "nsis-3.11.zip");
      if (existsSync(nsisRoot)) rmSync(nsisRoot, { recursive: true, force: true });
      const extracted = join(root, NSIS_ZIP_FOLDER);
      if (existsSync(extracted)) rmSync(extracted, { recursive: true, force: true });
      const files = extractZip(archive, root);
      renameSync(extracted, nsisRoot);
      console.log(`seeded ${nsisRoot} (${files} files, makensis.exe sha1 ${sha1(join(nsisRoot, "makensis.exe"))})`);
    } catch (cause) {
      ok = false;
      console.warn(`warn   nsis toolset: ${cause.message}`);
    }
  } else {
    console.log(`skip   ${nsisRoot}`);
  }

  const pluginPath = join(nsisRoot, "Plugins", "x86-unicode", "additional", "nsis_tauri_utils.dll");
  try {
    await saveAsset({
      owner: "tauri-apps",
      repo: "nsis-tauri-utils",
      tag: "nsis_tauri_utils-v0.5.3",
      asset: "nsis_tauri_utils.dll",
      target: pluginPath,
    });
    if (existsSync(pluginPath)) console.log(`check  nsis_tauri_utils.dll sha1 ${sha1(pluginPath)}`);
  } catch (cause) {
    ok = false;
    console.warn(`warn   nsis_tauri_utils.dll: ${cause.message}`);
  }
  return ok;
}

async function main() {
  const root = cacheRoot();
  mkdirSync(root, { recursive: true });
  console.log(`cache  ${root}`);

  let ok = true;
  if (process.platform === "linux") ok = await seedLinux(root);
  else if (process.platform === "win32") ok = await seedWindows(root);
  else console.log(`skip   ${process.platform} does not need these tools`);

  console.log(ok ? "done   bundler tools ready" : "done   some tools were not seeded; the build will fall back to a direct download");
}

main().catch((cause) => {
  console.warn(`warn   seeder crashed: ${cause && cause.stack ? cause.stack : cause}`);
  process.exit(0);
});
