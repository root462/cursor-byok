//! Detects the Cursor desktop application installed on this machine.
//!
//! The version is read from the Electron bundle metadata
//! (`resources/app/package.json`), which Cursor ships with every build and is
//! therefore far more reliable than parsing `--version` output.

use std::{
    env,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How far up from an executable we look for the application root.
const MAX_ANCESTOR_DEPTH: usize = 6;

#[derive(Clone, Debug, Serialize)]
pub struct CursorAppInfo {
    /// Whether a Cursor installation could be located.
    pub installed: bool,
    /// Marketing version, e.g. `3.29.9`.
    pub version: Option<String>,
    /// Build identifier Cursor records in `distro` / `commit`.
    pub build: Option<String>,
    /// Installation root, e.g. `C:\Users\me\AppData\Local\Programs\cursor`.
    pub app_root: Option<String>,
    /// Launcher path that was used to find the installation.
    pub executable: Option<String>,
    /// Whether a Cursor process is currently running.
    pub running: bool,
    /// Whether the version came from the bundled metadata or a launcher probe.
    pub source: Option<String>,
}

impl CursorAppInfo {
    fn missing(running: bool) -> Self {
        Self {
            installed: false,
            version: None,
            build: None,
            app_root: None,
            executable: None,
            running,
            source: None,
        }
    }
}

pub async fn detect_cursor_app() -> CursorAppInfo {
    let running = is_running().await;
    let Some(app) = locate() else {
        return CursorAppInfo::missing(running);
    };
    CursorAppInfo {
        installed: true,
        version: app.version,
        build: app.build,
        app_root: Some(app.root.display().to_string()),
        executable: app.executable.map(|path| path.display().to_string()),
        running,
        source: Some(if app.from_bundle {
            "bundle".into()
        } else {
            "launcher".into()
        }),
    }
}

struct Located {
    root: PathBuf,
    version: Option<String>,
    build: Option<String>,
    executable: Option<PathBuf>,
    from_bundle: bool,
}

fn locate() -> Option<Located> {
    for root in installation_roots() {
        if let Some(located) = inspect_root(&root) {
            return Some(located);
        }
    }
    // Portable installs live wherever the user unpacked them. Any `PATH` entry
    // inside the tree (Cursor adds `resources/app/bin`) identifies the root, so
    // walk up from every entry before falling back to launcher probing.
    for dir in path_dirs() {
        for root in std::iter::once(dir.clone()).chain(ancestors(&dir)) {
            if let Some(located) = inspect_root(&root) {
                return Some(located);
            }
        }
    }
    for launcher in launchers() {
        if let Some(located) = probe_launcher(&launcher) {
            return Some(located);
        }
    }
    None
}

fn inspect_root(root: &Path) -> Option<Located> {
    let package = bundle_package_json(root)?;
    let data = std::fs::read_to_string(&package).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&data).ok()?;
    let version = parsed
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let build = ["distro", "commit", "quality"]
        .iter()
        .find_map(|key| {
            parsed
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        });
    Some(Located {
        root: root.to_path_buf(),
        version,
        build,
        executable: launcher_in_root(root),
        from_bundle: true,
    })
}

/// Returns `<root>/resources/app/package.json` for Windows/Linux layouts and
/// `<root>/Contents/Resources/app/package.json` for macOS bundles.
fn bundle_package_json(root: &Path) -> Option<PathBuf> {
    let candidates = [
        root.join("resources/app/package.json"),
        root.join("Contents/Resources/app/package.json"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn launcher_in_root(root: &Path) -> Option<PathBuf> {
    let candidates = [
        root.join("Cursor.exe"),
        root.join("Contents/MacOS/Cursor"),
        root.join("cursor"),
        root.join("cursor.sh"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

/// Well-known installation locations per platform.
fn installation_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if !roots.contains(&path) {
            roots.push(path);
        }
    };
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local).join("Programs");
        push(base.join("cursor"));
        push(base.join("Cursor"));
    }
    if let Some(program_files) = env::var_os("ProgramFiles") {
        let base = PathBuf::from(program_files);
        push(base.join("cursor"));
        push(base.join("Cursor"));
    }
    if let Some(program_files) = env::var_os("ProgramFiles(x86)") {
        let base = PathBuf::from(program_files);
        push(base.join("cursor"));
        push(base.join("Cursor"));
    }
    if let Some(home) = dirs::home_dir() {
        // macOS bundles, including the ones users drag into their own folder.
        push(PathBuf::from("/Applications/Cursor.app"));
        push(home.join("Applications/Cursor.app"));
        push(PathBuf::from("/Applications/Cursor Nightly.app"));
        // Linux layouts, both system- and user-scoped.
        push(home.join(".local/share/cursor"));
        push(home.join(".local/opt/cursor"));
    }
    push(PathBuf::from("/usr/share/cursor"));
    push(PathBuf::from("/usr/lib/cursor"));
    push(PathBuf::from("/opt/cursor"));
    push(PathBuf::from("/opt/Cursor"));
    push(PathBuf::from("/snap/cursor/current"));
    // Portable installs are often unpacked next to a drive root; the launcher
    // probe below handles those, so nothing extra is needed here.
    roots
}

fn launcher_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["Cursor.exe", "cursor.exe", "cursor.cmd", "cursor.bat", "cursor"]
    } else {
        &["cursor", "Cursor"]
    }
}

/// Launchers found on `PATH`, in declaration order.
fn launchers() -> Vec<PathBuf> {
    let names = launcher_names();
    let mut found = Vec::new();
    for dir in path_dirs() {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() && !found.contains(&candidate) {
                found.push(candidate);
            }
        }
    }
    found
}

fn path_dirs() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn ancestors(path: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut current = path.parent();
    let mut depth = 0;
    while let Some(dir) = current {
        if depth >= MAX_ANCESTOR_DEPTH {
            break;
        }
        roots.push(dir.to_path_buf());
        current = dir.parent();
        depth += 1;
    }
    roots
}

/// Runs `<launcher> --version` for installs whose bundle metadata is missing.
fn probe_launcher(launcher: &Path) -> Option<Located> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(launcher);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = std::process::Command::new(launcher);
    let output = command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text
        .split_whitespace()
        .find(|token| {
            token
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_digit())
                && token.contains('.')
        })
        .map(|token| token.trim().to_owned())?;
    Some(Located {
        root: launcher.parent()?.to_path_buf(),
        version: Some(version),
        build: None,
        executable: Some(launcher.to_path_buf()),
        from_bundle: false,
    })
}

async fn is_running() -> bool {
    #[cfg(windows)]
    {
        let mut command = Command::new("tasklist");
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command
            .args(["/FI", "IMAGENAME eq Cursor.exe", "/NH", "/FO", "CSV"])
            .output()
            .await;
        matches!(output, Ok(output) if output.status.success()
            && String::from_utf8_lossy(&output.stdout).to_ascii_lowercase().contains("cursor.exe"))
    }
    #[cfg(not(windows))]
    {
        for name in ["Cursor", "cursor"] {
            let found = Command::new("pgrep")
                .args(["-x", name])
                .output()
                .await
                .map(|output| output.status.success())
                .unwrap_or(false);
            if found {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_package_json_prefers_platform_layout() {
        let dir = std::env::temp_dir().join("cursor-byok-app-info-test");
        let nested = dir.join("resources/app");
        std::fs::create_dir_all(&nested).expect("create fixture");
        let package = nested.join("package.json");
        std::fs::write(&package, "{\"version\":\"1.2.3\"}").expect("write fixture");
        let found = bundle_package_json(&dir).expect("locate package.json");
        assert_eq!(found, package);
        let located = inspect_root(&dir).expect("inspect root");
        assert_eq!(located.version.as_deref(), Some("1.2.3"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
