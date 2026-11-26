//! Read-only installation probes for Codex Desktop and Claude CLI.

use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::Serialize;
use tokio::{process::Command, time::timeout};

#[derive(Default, Serialize)]
pub struct ClientAppInfo {
    /// None when the platform has no installation probe.
    installed: Option<bool>,
    version: Option<String>,
}

pub async fn detect_claude_app() -> ClientAppInfo {
    let Some(executable) = claude_executable() else {
        return ClientAppInfo { installed: Some(false), version: None };
    };
    let mut command = Command::new(executable);
    command.arg("--version");
    let version = probe_output(command).await.as_deref().and_then(claude_version);
    claude_info(true, version)
}

fn claude_info(executable_found: bool, version: Option<String>) -> ClientAppInfo {
    ClientAppInfo { installed: Some(executable_found), version: if executable_found { version } else { None } }
}

fn claude_executable() -> Option<PathBuf> {
    let search_path = env::var_os("PATH");
    let mut dirs: Vec<_> = search_path.iter().flat_map(env::split_paths).collect();
    // GUI launches on macOS/Linux need not inherit the shell's PATH.
    #[cfg(unix)]
    dirs.extend(dirs::home_dir().map(|home| home.join(".local/bin")));
    #[cfg(target_os = "macos")]
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    dirs.into_iter()
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    metadata.is_file()
}

fn claude_version(output: &str) -> Option<String> {
    output.lines().filter_map(|line| line.split_whitespace().next()).find(|token| {
        let core = token.split(['-', '+']).next().unwrap_or_default();
        core.split('.').count() == 3
            && core.split('.').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    }).map(str::to_owned)
}

#[cfg(any(target_os = "macos", test))]
fn codex_bundle_candidates(directory: &Path) -> [PathBuf; 2] {
    [directory.join("Codex.app"), directory.join("ChatGPT.app")]
}

#[cfg(any(target_os = "macos", test))]
fn codex_info(bundle_id: &str, version: Option<String>) -> ClientAppInfo {
    if bundle_id == super::process::CODEX_BUNDLE_ID {
        ClientAppInfo { installed: Some(true), version }
    } else {
        ClientAppInfo { installed: Some(false), version: None }
    }
}

#[cfg(target_os = "macos")]
pub async fn detect_codex_app() -> ClientAppInfo {
    // The desktop app may be named either Codex.app or ChatGPT.app. Check the
    // bundle ID so the regular ChatGPT app and the Codex CLI are never reported.
    let mut dirs = vec![PathBuf::from("/Applications")];
    dirs.extend(dirs::home_dir().map(|home| home.join("Applications")));
    for dir in dirs {
        for bundle in codex_bundle_candidates(&dir) {
            let plist = bundle.join("Contents/Info.plist");
            if plist.is_file() && plist_string(&plist, "CFBundleIdentifier").await.as_deref()
                == Some(super::process::CODEX_BUNDLE_ID)
            {
                return codex_info(
                    super::process::CODEX_BUNDLE_ID,
                    plist_string(&plist, "CFBundleShortVersionString").await,
                );
            }
        }
    }
    ClientAppInfo { installed: Some(false), version: None }
}

#[cfg(target_os = "macos")]
async fn plist_string(plist: &Path, key: &str) -> Option<String> {
    let mut command = Command::new("/usr/bin/plutil");
    command.args(["-extract", key, "raw", "-o", "-"]).arg(plist);
    probe_output(command).await.filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "macos"))]
pub async fn detect_codex_app() -> ClientAppInfo {
    // No trusted package identity is available on this platform yet.
    ClientAppInfo::default()
}

async fn probe_output(mut command: Command) -> Option<String> {
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command.stdin(Stdio::null()).kill_on_drop(true);
    let output = timeout(Duration::from_secs(3), command.output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::{claude_info, claude_version, codex_bundle_candidates, codex_info};
    use std::path::Path;

    #[test]
    fn parses_claude_code_version() {
        assert_eq!(claude_version("2.1.330 (Claude Code)\n").as_deref(), Some("2.1.330"));
        assert_eq!(claude_version("Warning: update available\n2.1.330-beta (Claude Code)").as_deref(), Some("2.1.330-beta"));
        assert_eq!(claude_version("Warning: 2.1.330 is available\nno version reported"), None);
    }

    #[test]
    fn executable_confirms_claude_install_even_without_version() {
        let app = claude_info(true, None);
        assert_eq!(app.installed, Some(true));
        assert_eq!(app.version, None);
        assert_eq!(claude_info(false, None).installed, Some(false));
    }

    #[test]
    fn checks_common_codex_bundle_names() {
        let paths = codex_bundle_candidates(Path::new("/Applications"));
        assert_eq!(paths[0], Path::new("/Applications/Codex.app"));
        assert_eq!(paths[1], Path::new("/Applications/ChatGPT.app"));
    }

    #[test]
    fn codex_bundle_id_confirms_install_even_without_version_metadata() {
        let app = codex_info("com.openai.codex", None);
        assert_eq!(app.installed, Some(true));
        assert_eq!(app.version, None);
        assert_eq!(codex_info("com.openai.chat", Some("1.0".into())).installed, Some(false));
    }
}
