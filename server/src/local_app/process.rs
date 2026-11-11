//! Terminates and inspects desktop processes for Cursor and Codex.

use tokio::process::Command;

use crate::{Error, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(windows)]
async fn is_any_process_running(names: &[&str]) -> bool {
    let mut command = Command::new("tasklist");
    hide_console(&mut command);
    let output = match command.args(["/NH", "/FO", "CSV"]).output().await {
        Ok(output) => output,
        Err(_) => return false,
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    names
        .iter()
        .any(|name| stdout.contains(&name.to_ascii_lowercase()))
}

#[cfg(not(windows))]
async fn is_any_process_running(names: &[&str]) -> bool {
    for name in names {
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

pub async fn is_cursor_running() -> bool {
    #[cfg(windows)]
    {
        is_any_process_running(&["Cursor.exe", "cursor.exe"]).await
    }
    #[cfg(not(windows))]
    {
        is_any_process_running(&["Cursor", "cursor"]).await
    }
}

pub async fn is_codex_running() -> bool {
    #[cfg(windows)]
    {
        is_any_process_running(&["Codex.exe", "codex.exe"]).await
    }
    #[cfg(not(windows))]
    {
        is_any_process_running(&["Codex", "codex"]).await
    }
}

pub async fn terminate_cursor() -> Result<()> {
    terminate_platform_cursor().await
}

pub async fn terminate_codex() -> Result<()> {
    terminate_platform_codex().await
}

#[cfg(target_os = "macos")]
async fn terminate_platform_cursor() -> Result<()> {
    terminate_unix_process("Cursor").await
}

#[cfg(target_os = "linux")]
async fn terminate_platform_cursor() -> Result<()> {
    terminate_unix_process("cursor").await?;
    terminate_unix_process("Cursor").await
}

#[cfg(target_os = "macos")]
async fn terminate_platform_codex() -> Result<()> {
    terminate_unix_process("Codex").await
}

#[cfg(target_os = "linux")]
async fn terminate_platform_codex() -> Result<()> {
    terminate_unix_process("codex").await?;
    terminate_unix_process("Codex").await
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn terminate_unix_process(name: &str) -> Result<()> {
    let running = Command::new("pgrep").args(["-x", name]).status().await?;
    if !running.success() {
        return match running.code() {
            Some(1) => Ok(()),
            _ => Err(Error::Config(format!(
                "failed to inspect the {name} process"
            ))),
        };
    }
    let terminated = Command::new("pkill").args(["-x", name]).status().await?;
    if terminated.success() || terminated.code() == Some(1) {
        Ok(())
    } else {
        Err(Error::Config(format!(
            "failed to terminate the {name} process"
        )))
    }
}

#[cfg(target_os = "windows")]
async fn terminate_windows_process(image_name: &str) -> Result<()> {
    let mut list = Command::new("tasklist");
    hide_console(&mut list);
    let processes = list
        .args([
            "/FI",
            &format!("IMAGENAME eq {image_name}"),
            "/NH",
            "/FO",
            "CSV",
        ])
        .output()
        .await?;
    if !processes.status.success() {
        return Err(Error::Config(format!(
            "failed to inspect the {image_name} process"
        )));
    }
    if !String::from_utf8_lossy(&processes.stdout)
        .to_ascii_lowercase()
        .contains(&image_name.to_ascii_lowercase())
    {
        return Ok(());
    }
    let mut kill = Command::new("taskkill");
    hide_console(&mut kill);
    let terminated = kill
        .args(["/F", "/T", "/IM", image_name])
        .status()
        .await?;
    if terminated.success() {
        Ok(())
    } else {
        Err(Error::Config(format!(
            "failed to terminate the {image_name} process"
        )))
    }
}

#[cfg(target_os = "windows")]
async fn terminate_platform_cursor() -> Result<()> {
    terminate_windows_process("Cursor.exe").await
}

#[cfg(target_os = "windows")]
async fn terminate_platform_codex() -> Result<()> {
    terminate_windows_process("Codex.exe").await
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
async fn terminate_platform_cursor() -> Result<()> {
    Err(Error::Config(format!(
        "terminating Cursor is unsupported on {}",
        std::env::consts::OS
    )))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
async fn terminate_platform_codex() -> Result<()> {
    Err(Error::Config(format!(
        "terminating Codex is unsupported on {}",
        std::env::consts::OS
    )))
}
