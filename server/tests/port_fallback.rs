//! Verifies that a busy configured port falls back to a random one, that the
//! Claude / Codex gateway URLs follow the port that was actually bound, and
//! that model edits keep reaching the client config files.
use std::{net::TcpListener as StdListener, time::Duration};

use cursor_server::{
    config::{Config, ConsoleSource},
    local_app::{ClaudeHarness, CodexHarness, ServiceAddr},
    model::{ModelConfigInput, ModelType},
    store::{PortSettings, Store},
    App,
};

/// `dirs::home_dir` reads HOME, which is process-wide. Tests that redirect it
/// must not run concurrently.
static HOME_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn model_input(model_id: &str) -> ModelConfigInput {
    ModelConfigInput {
        sort_order: 0,
        display_name: model_id.into(),
        group_name: None,
        model_type: ModelType::OpenAi,
        base_url: "https://api.deepseek.com".into(),
        use_full_url: false,
        api_key: "sk-test".into(),
        tooltip_data: "DeepSeek models".into(),
        model_id: model_id.into(),
        reasoning_effort: None,
        openai_endpoint: String::new(),
        openai_extra_params_enabled: false,
        openai_extra_params: serde_json::json!({}),
        custom_headers_enabled: false,
        custom_headers: serde_json::json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: serde_json::json!({}),
        context_window_tokens: Some(64_000),
        max_completion_tokens: None,
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }
}

/// Points HOME at a temporary directory and returns a store inside it.
async fn temp_home() -> (tempfile::TempDir, String, Store) {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    let data_dir = home.path().join(".cursor-byok-v3");
    std::fs::create_dir_all(&data_dir).unwrap();
    let database_url = format!("sqlite://{}", data_dir.join("cursor-byok.db").display());
    let store = Store::connect(&database_url).await.unwrap();
    (home, database_url, store)
}

fn desktop_config(database_url: String) -> Config {
    Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        database_url,
        provider_request_timeout: Duration::from_secs(60),
        provider_stream_idle_timeout: Duration::from_secs(60),
        console: None::<ConsoleSource>,
        use_persisted_ports: true,
        app_version: "test".into(),
    }
}

/// Waits until `path` contains `needle`, so background syncs can be observed.
async fn wait_for(path: &std::path::Path, needle: &str) -> String {
    let mut text = String::new();
    for _ in 0..60 {
        text = std::fs::read_to_string(path).unwrap_or_default();
        if text.contains(needle) {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    text
}

#[tokio::test(flavor = "multi_thread")]
async fn busy_port_falls_back_and_clients_follow_the_bound_port() {
    let _guard = HOME_LOCK.lock().await;
    let (home, database_url, store) = temp_home().await;
    for client in ["claude", "codex"] {
        store
            .create_client_models(client, &[model_input("deepseek-chat")])
            .await
            .unwrap();
    }

    // Both clients were taken over while the service ran on port 3000.
    let previous = ServiceAddr::default();
    previous.set("127.0.0.1:3000".parse().unwrap());
    ClaudeHarness::new(store.clone(), previous.clone())
        .set_enabled(true)
        .await
        .unwrap();
    CodexHarness::new(store.clone(), previous)
        .set_enabled(true, false)
        .await
        .unwrap();

    // The port the user configured is now taken by another process.
    let occupied = StdListener::bind("127.0.0.1:3000")
        .or_else(|_| StdListener::bind("127.0.0.1:0"))
        .unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    store
        .set_port_settings(PortSettings {
            proxy_port: 0,
            service_port: occupied_port,
        })
        .await
        .unwrap();

    let app = App::new(desktop_config(database_url)).await.unwrap();
    let listener = app.bind().await.unwrap();
    let bound_port = listener.local_addr().unwrap().port();
    assert_ne!(
        bound_port, occupied_port,
        "the occupied port must not be reused"
    );

    let claude_path = home.path().join(".claude/settings.json");
    let claude = wait_for(&claude_path, &format!("127.0.0.1:{bound_port}/claude")).await;
    assert!(
        claude.contains(&format!("127.0.0.1:{bound_port}/claude")),
        "claude settings did not follow the bound port: {claude}"
    );
    let codex_path = home.path().join(".codex/config.toml");
    let codex = wait_for(&codex_path, &format!("127.0.0.1:{bound_port}/codex")).await;
    assert!(
        codex.contains(&format!("127.0.0.1:{bound_port}/codex")),
        "codex config did not follow the bound port: {codex}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn model_edits_still_reach_client_configs_when_the_port_is_unchanged() {
    let _guard = HOME_LOCK.lock().await;
    let (home, _database_url, store) = temp_home().await;
    let address = ServiceAddr::default();
    address.set("127.0.0.1:3000".parse().unwrap());
    let claude = ClaudeHarness::new(store.clone(), address.clone());
    let codex = CodexHarness::new(store.clone(), address);

    store
        .create_client_models("claude", &[model_input("first-model")])
        .await
        .unwrap();
    claude.set_enabled(true).await.unwrap();
    store
        .create_client_models("codex", &[model_input("first-model")])
        .await
        .unwrap();
    codex.set_enabled(true, false).await.unwrap();

    // A new model is added while the port stays the same. The config files
    // must still be rewritten, even though the gateway URL is unchanged.
    store
        .create_client_models("claude", &[model_input("second-model")])
        .await
        .unwrap();
    store
        .create_client_models("codex", &[model_input("second-model")])
        .await
        .unwrap();
    claude.sync_if_applied().await.unwrap();
    codex.sync_if_applied().await.unwrap();

    let settings = std::fs::read_to_string(home.path().join(".claude/settings.json")).unwrap();
    assert!(
        settings.contains("second-model"),
        "claude settings lost the newly added model: {settings}"
    );
    let config = std::fs::read_to_string(home.path().join(".codex/config.toml")).unwrap();
    let catalog =
        std::fs::read_to_string(home.path().join(".codex/cursor-byok-model-catalog.json")).unwrap();
    assert!(
        config.contains("127.0.0.1:3000/codex") && catalog.contains("second-model"),
        "codex catalog lost the newly added model"
    );
}
