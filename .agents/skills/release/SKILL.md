---
name: release
description: Build and publish Cursor BYOK desktop releases through GitHub Actions. Use for version bumps, release tags, release workflow runs, updater manifests, signing keys, or diagnosing a failed release.
---

# Desktop release

Releases are built by `.github/workflows/release.yml` on GitHub-hosted runners and published as a GitHub Release.
Local packaging is not available on this machine — see "Why CI builds only".

## Why CI builds only

The maintainer machine runs Windows Smart App Control in enforcement mode
(`VerifiedAndReputablePolicyState=1`, policy `{0283ac0f-fff1-49ae-ada1-8a933130cad6}`).
Any newly compiled unsigned executable is refused before it starts:

```text
os error 4551 / Permission denied / "已被 Device Guard 阻止"
```

This is not path-, size-, or toolchain-specific: a `rustc`-compiled hello world fails the same way,
on any volume. Binaries that already had reputation before SAC was enabled still run.
Consequences:

- `make build-desktop`, `cargo build --release`, and `tauri build` fail locally. Do not retry them.
- `cargo fmt`, `cargo clippy`, and `cargo test` also fail locally, so Rust quality is not machine-checked.
- `npm --prefix apps/desktop run build` works (Node, not a native binary) and is the only local gate.
- Only `Smart App Control` being turned off (irreversible; requires admin + reboot) changes this.
  Never suggest it as a routine workaround.

## Publication authority

- Only the repository owner, GitHub user `root462`, may publish. The workflow enforces this:
  `GITHUB_ACTOR` must equal `REPOSITORY_OWNER`, otherwise `prepare` fails with
  `Only root462 may publish a release`.
- Treat these as publication actions and require an explicit instruction in the current task:
  pushing a `v*` tag, re-running the release workflow, and publishing or editing a GitHub Release.
- Never infer publication permission from words like "prepare", "check", or "ready to release".
- Never print, commit, or upload the updater private key. It lives outside the repo.

## Hard constraints from the workflow

`prepare` verifies all of the following and fails the run on any mismatch:

| Check | Requirement |
|---|---|
| Version match | `tauri.conf.json` version == `package.json` version == `Cargo.toml` version |
| Tag match | Tag is `v<version>` with `GITHUB_REF_TYPE == tag` |
| Commit ancestry | The tagged commit is contained in `origin/master` |
| Signing secret | `TAURI_SIGNING_PRIVATE_KEY` is configured |
| Idempotency | Version not already published (`gh release view v<version>` not non-draft) |

Other rules:

- Version is `MAJOR.MINOR.PATCH` only. Four-part numbers (`1.0.2.1`) are rejected by Cargo
  (`unexpected character '.' after patch version number`), npm, and Tauri.
- A prerelease keeps `prerelease: false` and is published as Latest; the release body just says Beta.
  This is required because the updater resolves through `/releases/latest/download/`.
- The repo's default branch is `master`, not `main`. The workflow hardcodes `origin/master`.
- Never republish a published version. Bump the version instead.

## Release sources

Keep the desktop version identical in all five spans:

```text
cursor-byok/
├── Cargo.lock                                    # name = "cursor-byok-desktop" → version
├── apps/desktop/
│   ├── package.json                              # "version"
│   ├── package-lock.json                         # top-level + packages[""].version (2 spans)
│   └── src-tauri/
│       ├── Cargo.toml                            # version =
│       └── tauri.conf.json                       # "version"
├── protocols/cursor/                             # committed build inputs for server/build.rs
│   ├── agent_v1.proto                            # compiled by prost into Rust bindings
│   └── aiserver_v1.proto                         # wire-contract assertions
└── .github/
    ├── workflows/release.yml                     # the whole pipeline
    └── scripts/
        ├── seed-bundler-tools.mjs                # preloads NSIS/AppRun via api.github.com
        └── normalize-tauri-update.mjs            # rewrites latest.json asset URLs
```

Self-check — all four lines must print the same value:

```bash
node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version"
node -p "require('./apps/desktop/package.json').version"
sed -n '/^version = / { s/version = "\([^"]*\)"/\1/p; q; }' apps/desktop/src-tauri/Cargo.toml
node -p "require('./apps/desktop/package-lock.json').version"
```

## Prepare and validate

1. Inspect `git status`; preserve unrelated user changes and do not stage them.
2. Bump the version in the five spans above. Do not touch the independent `cursor-server` version.
3. Confirm the updater public key in `tauri.conf.json` still pairs with the private key before relying on it:
   `C:/Users/FJZ15/AppData/Local/byok-signing.key` (no password) with `byok-signing.key.pub` beside it.
   Compare key IDs rather than assuming:

   ```bash
   node -e "const fs=require('fs');
   const keyId=b64=>Buffer.from(Buffer.from(b64.trim(),'base64').toString('latin1').trim().split(/\r?\n/)[1],'base64').subarray(2,10).toString('hex').toUpperCase();
   const pub=keyId(fs.readFileSync('C:/Users/FJZ15/AppData/Local/byok-signing.key.pub','utf8'));
   const conf=keyId(require('./apps/desktop/src-tauri/tauri.conf.json').plugins.updater.pubkey);
   console.log(pub, conf, pub===conf);"
   ```

   Both `.pub` and the configured `pubkey` are base64-of-a-minisign-file, so the value is decoded twice.

4. Confirm neither the tag nor the Release already exists.
5. Run the only local gate that works:

   ```bash
   npm --prefix apps/desktop run build
   ```

6. Stage only the release set and inspect the diff before committing.

## Publish and verify

1. Push the release commit to `master` first:

   ```bash
   git push origin master
   ```

2. Create and push the tag. Order matters — `prepare` rejects a tag that is not yet an ancestor of
   `origin/master`:

   ```bash
   git tag v1.0.4
   GIT_SSH_COMMAND="ssh -p 443" git push git@ssh.github.com:root462/cursor-byok.git refs/tags/v1.0.4
   ```

   `github.com:443` and `api.github.com` intermittently time out or return 504 on this machine.
   SSH on port 443 is the reliable path; plain `git push` through HTTPS often fails.

3. Follow the run. It takes 25–40 minutes; `macos-x86_64` is always last.

   ```text
   Prepare release          → version/tag/ancestry/secret checks, idempotency
   Publish (linux-x86_64)   → AppImage, .deb, .rpm
   Publish (windows-x86_64) → NSIS installer
   Publish (macos-aarch64)  → Apple Silicon
   Publish (macos-x86_64)   → Intel
   Publish GitHub Release   → collect assets, normalize latest.json, flip draft → latest
   ```

   Any failed `Publish` job prevents `finalize`; the Release stays a draft.

4. Verify the Release:

   ```bash
   curl -sS -H 'user-agent: check' -o rel.json \
     'https://api.github.com/repos/root462/cursor-byok/releases/tags/v1.0.4'
   node -e "const r=require('./rel.json');
   console.log('draft:',r.draft,'| prerelease:',r.prerelease);
   r.assets.forEach(a=>console.log('  '+a.name+'  '+a.size+' bytes'));"
   ```

   Required: `draft: false`, `prerelease: false`, and assets covering `*-setup.exe` + `.sig`,
   both macOS `.app.tar.gz`, the Linux AppImage/deb/rpm, the legacy per-platform archives, and `latest.json`.

5. Verify the updater manifest — this is what existing users download:

   ```bash
   curl -sSL -o latest.json \
     'https://github.com/root462/cursor-byok/releases/download/v1.0.4/latest.json'
   node -e "const j=require('./latest.json');console.log('version:',j.version);
   Object.entries(j.platforms).forEach(([k,v])=>console.log('  '+k+' -> '+v.url));"
   ```

   Every platform URL must point at the new version's assets and every signature must use the
   key ID from step 3 of "Prepare". Delete both temp files afterwards.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `Only root462 may publish a release` | Tag pushed by another account | Push as the owner |
| `Release tag must point to a commit contained in origin/master` | Tag pushed before `master` | Push `master`, then `git tag -f` + `git push --force` |
| `Version x is already published; nothing to do.` | Idempotency guard | Expected; delete the Release and re-push the tag only with explicit authorization |
| `Downloading .../nsis-3.11.zip -> http status: 504` | `github.com/.../releases/download/` outage | `seed-bundler-tools.mjs` already preloads via `api.github.com`; if it still fails, re-run the job |
| `failed to read file '...\\permissions\\...toml': os error 3` | Stale `target/` built from an older checkout path | Delete the offending `target/release/build/<pkg>-*` and `.fingerprint/<pkg>-*` entries |
| `os error 4551` locally | Smart App Control | Build on CI; do not fight it locally |

If only some platforms are missing, do not re-push the tag. Use
**Actions → Supplement desktop installers → Run workflow** with `version` (no `v`) and the full
40-character `source_commit`. It builds only deb/AppImage/dmg/app and requires the Release to exist
and be non-draft.