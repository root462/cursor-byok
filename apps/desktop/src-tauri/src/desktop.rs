use std::{
    process::{Command, ExitCode},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use axum::{
    extract::{Extension, Json},
    http::StatusCode,
    routing::{get, post},
    Router,
};
use tauri::{
    async_runtime::JoinHandle, webview::Color, AppHandle, Manager, RunEvent, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tokio_util::sync::CancellationToken;

#[cfg(dev)]
use cursor_server::config::ConsoleSource;
use cursor_server::{reqwest, store::Store, App, Config, Result};

#[cfg(not(dev))]
use crate::frontend;
use crate::startup::{self, StartupDiagnostics};
use crate::tray;

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
const AUTOSTART_ARG: &str = "--autostart";

struct DesktopRuntime {
    shutdown: CancellationToken,
    server: Mutex<Option<JoinHandle<Result<()>>>>,
    exiting: AtomicBool,
    server_addr: std::net::SocketAddr,
}

/// 选择一个本地文件夹，返回绝对路径；用户取消时返回 `None`。
/// Skill 是整目录安装，所以这里只要目录，不要文件。
#[tauri::command]
async fn pick_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Select Skill directory")
        .pick_folder()
        .await
        .map(|handle| handle.path().to_string_lossy().to_string())
}

#[tauri::command]
fn open_terminal_with_command(command: String) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = command;
        Command::new("open").args(["-a", "Terminal"]).status()?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", &command])
            .spawn()?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        const TERMINALS: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e"]),
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("xfce4-terminal", &["--execute"]),
            ("alacritty", &["-e"]),
            ("kitty", &[]),
        ];
        let script = format!("{command}; exec bash");
        for (terminal, separator) in TERMINALS {
            let mut process = Command::new(terminal);
            process.args(*separator);
            process.arg("bash").arg("-c").arg(&script);
            match process.spawn() {
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(tauri::Error::from(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no supported terminal emulator found",
        )))
    }
}

#[derive(serde::Deserialize)]
struct OpenExternalUrlRequest {
    url: String,
}

fn open_external_url(app: &AppHandle, url: &str) -> std::result::Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|error| format!("invalid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("only absolute HTTP and HTTPS URLs are allowed".into());
    }

    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("failed to open URL: {error}"))
}

async fn open_external_url_handler(
    Extension(app): Extension<AppHandle>,
    Json(request): Json<OpenExternalUrlRequest>,
) -> std::result::Result<StatusCode, (StatusCode, String)> {
    open_external_url(&app, &request.url)
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|error| (StatusCode::BAD_REQUEST, error))
}

#[derive(serde::Deserialize)]
struct SwitchVersionRequest {
    version: String,
}

async fn switch_version_handler(
    Extension(app): Extension<AppHandle>,
    Json(request): Json<SwitchVersionRequest>,
) -> std::result::Result<StatusCode, (StatusCode, String)> {
    let clean_version = request.version.trim().trim_start_matches('v');
    if clean_version.is_empty()
        || !clean_version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err((StatusCode::BAD_REQUEST, "invalid version format".into()));
    }

    let endpoint_str = format!(
        "https://github.com/root462/cursor-byok/releases/download/v{clean_version}/latest.json"
    );
    let target_url = url::Url::parse(&endpoint_str).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            format!("invalid endpoint URL: {error}"),
        )
    })?;

    let updater = app
        .updater_builder()
        .endpoints(vec![target_url])
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to configure updater endpoint: {error}"),
            )
        })?
        .version_comparator(|_, _| true)
        .build()
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to initialize updater: {error}"),
            )
        })?;

    let update = updater.check().await.map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to check target release manifest: {error}"),
        )
    })?;

    let Some(update) = update else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("version v{clean_version} release manifest not found or incompatible"),
        ));
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to download and install version v{clean_version}: {error}"),
            )
        })?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
struct ReleaseInfoResponse {
    version: String,
    #[serde(rename = "tagName")]
    tag_name: String,
    name: String,
    #[serde(rename = "publishedAt")]
    published_at: String,
    body: String,
    prerelease: bool,
}

#[derive(serde::Deserialize)]
struct GitHubReleaseItem {
    tag_name: Option<String>,
    name: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

fn strip_html_and_unescape(input: &str) -> String {
    let unescaped = input
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");

    let mut result = String::with_capacity(unescaped.len());
    let mut in_tag = false;
    for c in unescaped.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(c);
        }
    }
    result.trim().to_string()
}

fn parse_atom_releases(xml: &str) -> Vec<ReleaseInfoResponse> {
    let mut releases = Vec::new();
    for block in xml.split("<entry>").skip(1) {
        let entry_content = match block.split("</entry>").next() {
            Some(c) => c,
            None => continue,
        };
        let tag = entry_content
            .split("/tag/")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or("")
            .trim();
        if tag.is_empty() {
            continue;
        }

        let title = entry_content
            .split("<title>")
            .nth(1)
            .and_then(|s| s.split("</title>").next())
            .unwrap_or(tag)
            .trim();

        let updated = entry_content
            .split("<updated>")
            .nth(1)
            .and_then(|s| s.split("</updated>").next())
            .unwrap_or("")
            .trim();

        let body = entry_content
            .split("<content")
            .nth(1)
            .and_then(|s| s.split_once('>'))
            .map(|(_, after_gt)| {
                let text = after_gt.split("</content>").next().unwrap_or("");
                strip_html_and_unescape(text)
            })
            .unwrap_or_default();

        let version = tag.trim_start_matches('v').to_string();
        releases.push(ReleaseInfoResponse {
            version,
            tag_name: tag.to_string(),
            name: title.to_string(),
            published_at: updated.to_string(),
            body,
            prerelease: false,
        });
    }
    releases
}

async fn fetch_releases_from_atom(
    client: &reqwest::Client,
) -> std::result::Result<Vec<ReleaseInfoResponse>, String> {
    let response = client
        .get("https://github.com/root462/cursor-byok/releases.atom")
        .header(reqwest::header::USER_AGENT, "Cursor-BYOK-Desktop")
        .send()
        .await
        .map_err(|e| format!("atom feed fetch error: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("atom feed returned HTTP {}", response.status()));
    }

    let xml = response
        .text()
        .await
        .map_err(|e| format!("atom feed read error: {e}"))?;

    let releases = parse_atom_releases(&xml);
    if releases.is_empty() {
        return Err("atom feed contained no valid release entries".into());
    }
    Ok(releases)
}

async fn release_history_handler(
    Extension(store): Extension<Store>,
) -> std::result::Result<Json<Vec<ReleaseInfoResponse>>, (StatusCode, String)> {
    let client = cursor_server::network::client(&store)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    // Try GitHub REST API first
    let rest_result = client
        .get("https://api.github.com/repos/root462/cursor-byok/releases?per_page=30")
        .header(reqwest::header::ACCEPT, "application/vnd.github.v3+json")
        .header(reqwest::header::USER_AGENT, "Cursor-BYOK-Desktop")
        .send()
        .await;

    if let Ok(response) = rest_result {
        if response.status().is_success() {
            if let Ok(items) = response.json::<Vec<GitHubReleaseItem>>().await {
                let releases: Vec<ReleaseInfoResponse> = items
                    .into_iter()
                    .filter(|r| !r.draft && r.tag_name.as_ref().is_some_and(|t| !t.is_empty()))
                    .map(|r| {
                        let tag = r.tag_name.unwrap_or_default();
                        let version = tag.trim_start_matches('v').to_string();
                        let name = r.name.unwrap_or_else(|| tag.clone());
                        ReleaseInfoResponse {
                            version,
                            tag_name: tag,
                            name,
                            published_at: r.published_at.unwrap_or_default(),
                            body: r.body.unwrap_or_default(),
                            prerelease: r.prerelease,
                        }
                    })
                    .collect();
                if !releases.is_empty() {
                    return Ok(Json(releases));
                }
            }
        }
    }

    // Fallback to releases.atom when REST API is rate-limited (403), blocked, or errors out
    match fetch_releases_from_atom(&client).await {
        Ok(releases) => Ok(Json(releases)),
        Err(error) => Err((
            StatusCode::BAD_GATEWAY,
            format!("failed to fetch releases: {error}"),
        )),
    }
}

fn desktop_api_router(app: AppHandle, store: Store) -> Router {
    Router::new()
        .route(
            "/__byok-api__/api/desktop/open-external-url",
            post(open_external_url_handler),
        )
        .route(
            "/__byok-api__/api/desktop/switch-version",
            post(switch_version_handler),
        )
        .route(
            "/__byok-api__/api/desktop/release-history",
            get(release_history_handler),
        )
        .layer(Extension(store))
        .layer(Extension(app))
}

fn create_main_window(
    app: &AppHandle,
    address: std::net::SocketAddr,
) -> tauri::Result<WebviewWindow> {
    let url = format!("http://{address}/__byok-api__/")
        .parse()
        .expect("local frontend URL");
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Cursor BYOK")
        .inner_size(972.0, 593.0)
        .min_inner_size(820.0, 558.0)
        .center()
        .background_color(Color(20, 20, 20, 255))
        .decorations(cfg!(target_os = "macos"))
        .shadow(true)
        .resizable(true)
        .visible(false);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    builder.build()
}

/// 按需打开主窗口:webview 仅在需要界面时创建,关闭窗口即销毁释放内存。
pub(crate) fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let address = app.state::<DesktopRuntime>().server_addr;
    let window = create_main_window(app, address)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub fn run() -> ExitCode {
    let diagnostics = match StartupDiagnostics::initialize() {
        Ok(diagnostics) => diagnostics,
        Err(error) => {
            startup::report_logging_failure(error.as_ref());
            return ExitCode::FAILURE;
        }
    };
    #[cfg(unix)]
    {
        let open_file_limit = match crate::resource_limits::raise_open_file_limit() {
            Ok(limit) => limit,
            Err(error) => {
                diagnostics.report_fatal(&error);
                return ExitCode::FAILURE;
            }
        };
        tracing::info!(
            requested = crate::resource_limits::REQUESTED_OPEN_FILE_LIMIT,
            previous = open_file_limit.previous,
            effective = open_file_limit.effective,
            hard = open_file_limit.hard,
            "open file limit configured"
        );
    }
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        architecture = std::env::consts::ARCH,
        log_directory = %diagnostics.log_directory().display(),
        "desktop starting"
    );

    let started_by_autostart = std::env::args_os().any(|arg| arg == AUTOSTART_ARG);

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_terminal_with_command, pick_directory])
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|arg| arg == AUTOSTART_ARG) {
                let _ = open_main_window(app);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec![AUTOSTART_ARG]),
            ))?;
            let config = Config::desktop()?;
            #[cfg(dev)]
            let config = {
                let mut config = config;
                config.console = Some(ConsoleSource::Proxy(
                    "http://127.0.0.1:1420"
                        .parse()
                        .expect("Vite development URL"),
                ));
                config
            };
            let app_instance = tauri::async_runtime::block_on(App::new(config))?;
            let store = app_instance.store();
            let server = app_instance.merge_router(desktop_api_router(app.handle().clone(), store));
            #[cfg(not(dev))]
            let server = server.merge_router(frontend::router(app.handle().clone()));
            let listener = tauri::async_runtime::block_on(server.bind())?;
            let address = listener.local_addr()?;
            tauri::async_runtime::block_on(server.harness().cleanup_stale_settings())?;
            let desktop_settings =
                tauri::async_runtime::block_on(server.store().desktop_settings())
                    .unwrap_or_default();
            #[cfg(target_os = "macos")]
            app.handle()
                .set_dock_visibility(desktop_settings.show_dock_icon)?;
            let shutdown = CancellationToken::new();
            let server_shutdown = shutdown.clone();
            let app_handle = app.handle().clone();
            let task = tauri::async_runtime::spawn(async move {
                let result = server.serve_on(listener, server_shutdown).await;
                if let Err(error) = &result {
                    tracing::error!(%error, "desktop server stopped unexpectedly");
                    app_handle.exit(1);
                }
                result
            });
            app.manage(DesktopRuntime {
                shutdown,
                server: Mutex::new(Some(task)),
                exiting: AtomicBool::new(false),
                server_addr: address,
            });
            if desktop_settings.silent_start && started_by_autostart {
                tracing::info!("silent autostart enabled; starting without the main window");
            } else {
                open_main_window(app.handle())?;
            }
            tray::create(app)?;
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            diagnostics.report_fatal(&error);
            return ExitCode::FAILURE;
        }
    };

    app.run(|app, event| match event {
        // code 为 None 表示所有窗口已被关闭(轻量模式),阻止退出,
        // 转发服务继续在托盘后台运行;code 为 Some 时是显式退出请求。
        RunEvent::ExitRequested { code, api, .. } => match code {
            None => api.prevent_exit(),
            Some(_) => {
                let runtime = app.state::<DesktopRuntime>();
                if !runtime.exiting.swap(true, Ordering::AcqRel) {
                    api.prevent_exit();
                    runtime.shutdown.cancel();
                    let server = runtime.server.lock().expect("server lock poisoned").take();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(server) = server {
                            match tokio::time::timeout(Duration::from_secs(11), server).await {
                                Ok(Ok(Ok(()))) => {}
                                Ok(Ok(Err(error))) => {
                                    tracing::error!(%error, "desktop server shutdown failed")
                                }
                                Ok(Err(error)) => {
                                    tracing::error!(%error, "desktop server task failed")
                                }
                                Err(_) => tracing::warn!("desktop server shutdown timed out"),
                            }
                        }
                        app.exit(0);
                    });
                }
            }
        },
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            let _ = open_main_window(app);
        }
        _ => {}
    });

    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_atom_releases_feed() {
        let sample = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1449368712/v1.0.5</id>
    <updated>2026-11-10T12:44:04Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/root462/cursor-byok/releases/tag/v1.0.5"/>
    <title>Cursor BYOK v1.0.5</title>
    <content type="html">&lt;p&gt;Download the installer for your platform from the assets below.&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1449368712/v1.0.4</id>
    <updated>2026-11-09T04:27:38Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/root462/cursor-byok/releases/tag/v1.0.4"/>
    <title>Cursor BYOK v1.0.4</title>
    <content type="html">&lt;p&gt;Bug fixes&lt;/p&gt;</content>
  </entry>
</feed>"#;
        let releases = parse_atom_releases(sample);
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].version, "1.0.5");
        assert_eq!(releases[0].tag_name, "v1.0.5");
        assert_eq!(releases[0].name, "Cursor BYOK v1.0.5");
        assert_eq!(releases[0].published_at, "2026-11-10T12:44:04Z");
        assert_eq!(
            releases[0].body,
            "Download the installer for your platform from the assets below."
        );
        assert_eq!(releases[1].version, "1.0.4");
        assert_eq!(releases[1].tag_name, "v1.0.4");
    }
}
