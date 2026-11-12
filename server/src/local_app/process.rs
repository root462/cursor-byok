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

/// Codex Desktop 当前的发布形态是一个 bundle 名为 `ChatGPT.app` 的应用，
/// 可执行文件叫 `ChatGPT`、bundle id 是 `com.openai.codex`。按进程名找会全部落空，
/// 所以 macOS 上统一按 bundle id 识别与退出。
#[cfg(target_os = "macos")]
const CODEX_BUNDLE_ID: &str = "com.openai.codex";

/// 按 bundle id 查主进程 PID；没运行时返回 `None`。
///
/// `lsappinfo` 直接读 LaunchServices 注册表，约 10ms，比 `pgrep` 扫全表还快，
/// 而且不受进程改名影响。
#[cfg(target_os = "macos")]
async fn codex_pid() -> Option<u32> {
    let asn = Command::new("lsappinfo")
        .args(["find", &format!("bundleID={CODEX_BUNDLE_ID}")])
        .output()
        .await
        .ok()?;
    if !asn.status.success() {
        return None;
    }
    let asn = String::from_utf8_lossy(&asn.stdout);
    let asn = asn.trim();
    if asn.is_empty() {
        return None;
    }
    let info = Command::new("lsappinfo")
        .args(["info", "-only", "pid", asn])
        .output()
        .await
        .ok()?;
    if !info.status.success() {
        return None;
    }
    // 输出形如 `pid = 16202 !cgsConnection ...`。
    String::from_utf8_lossy(&info.stdout)
        .split_whitespace()
        .skip_while(|token| *token != "=")
        .nth(1)
        .and_then(|pid| pid.parse().ok())
}

pub async fn is_codex_running() -> bool {
    #[cfg(target_os = "macos")]
    {
        codex_pid().await.is_some()
    }
    #[cfg(windows)]
    {
        is_any_process_running(&["Codex.exe", "codex.exe", "ChatGPT.exe"]).await
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
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

/// 重新打开 Codex：用与「用户自己点图标」等价的方式启动，
/// 让它读取刚恢复的默认配置，而不是沿用进程里缓存的旧设置。
pub async fn launch_codex() -> Result<()> {
    launch_platform_codex().await
}

/// 后台退出 Codex，不重新打开。用于关闭接管：进程不再走本地代理，
/// 何时再启动由用户决定。放在请求线程里会让开关卡到进程真正消失。
pub fn terminate_codex_async() {
    tokio::spawn(async move {
        if let Err(error) = terminate_codex().await {
            tracing::warn!(%error, "failed to terminate Codex");
        }
    });
}

/// 先退出再重新打开 Codex。进程本来没跑时什么都不做，不会凭空把应用拉起来。
///
/// 整段在后台任务里跑：退出要等进程真正消失（应用退出可能要几百毫秒），
/// 重新打开又要等 LaunchServices 完成启动。放在请求线程里会让开关卡上一两秒。
pub fn restart_codex() {
    tokio::spawn(async move {
        if !is_codex_running().await {
            return;
        }
        if let Err(error) = terminate_codex().await {
            tracing::warn!(%error, "failed to terminate Codex");
            return;
        }
        // 进程收到信号到真正退出之间有一段窗口。必须等它从 LaunchServices
        // 消失再拉起，否则这次启动会被当成「重新激活已有实例」，什么都不做。
        for _ in 0..50 {
            if !is_codex_running().await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        }
        if let Err(error) = launch_codex().await {
            tracing::warn!(%error, "failed to reopen Codex");
        }
    });
}

#[cfg(target_os = "macos")]
async fn launch_platform_codex() -> Result<()> {
    // 按 bundle id 打开：不依赖应用装在哪里，也不依赖当前的显示名。
    let launched = Command::new("open")
        .args(["-b", CODEX_BUNDLE_ID])
        .status()
        .await?;
    if launched.success() {
        Ok(())
    } else {
        Err(Error::Config("failed to reopen Codex".into()))
    }
}

#[cfg(target_os = "windows")]
async fn launch_platform_codex() -> Result<()> {
    // Start-Process 走 shell 关联启动 Codex，等价于开始菜单里点一下。
    let mut command = Command::new("powershell");
    hide_console(&mut command);
    let launched = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Start-Process -FilePath 'Codex.exe'",
        ])
        .status()
        .await?;
    if launched.success() {
        Ok(())
    } else {
        Err(Error::Config("failed to reopen Codex".into()))
    }
}

#[cfg(target_os = "linux")]
async fn launch_platform_codex() -> Result<()> {
    for name in ["codex", "Codex"] {
        match Command::new(name).spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::Config("failed to reopen Codex".into()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
async fn launch_platform_codex() -> Result<()> {
    Err(Error::Config(format!(
        "reopening Codex is unsupported on {}",
        std::env::consts::OS
    )))
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

/// macOS 上按 bundle id 找到主进程后用 SIGTERM 退出：走应用自己的退出流程，
/// 未保存的会话与窗口状态会被正常保留；强杀会把它们一起丢掉。
#[cfg(target_os = "macos")]
async fn terminate_platform_codex() -> Result<()> {
    let Some(pid) = codex_pid().await else {
        return Ok(());
    };
    let terminated = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .await?;
    if terminated.success() {
        Ok(())
    } else {
        Err(Error::Config("failed to terminate Codex".into()))
    }
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
