//! Verifies the TAB settings surface: the custom service key and model survive a
//! round trip, and the settings page can list the models that service exposes.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::{Arc, Mutex};

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, Request, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use cursor_server::{
    control,
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
};
use serde_json::{json, Value};
use tower::ServiceExt;

/// Records the authorization header each discovery request carried.
#[derive(Clone, Default)]
struct SeenAuth(Arc<Mutex<Vec<Option<String>>>>);

async fn openai_models(State(seen): State<SeenAuth>, request: Request<Body>) -> impl IntoResponse {
    seen.0.lock().unwrap().push(
        request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    );
    Json(json!({ "data": [{ "id": "qwen3-coder" }, { "id": "claude-tab" }] }))
}

async fn setup() -> (Router, SeenAuth, String, tempfile::TempDir) {
    let (directory, store) = fixtures::temp_store().await;
    let seen = SeenAuth::default();
    let tab_service = Router::new()
        .route("/v1/models", get(openai_models))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, tab_service).await.unwrap();
    });

    let provider = fake_provider::FakeProvider::default();
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "0.1.0".into()).unwrap();
    let service = control::ControlService::new(
        store.clone(),
        Default::default(),
        Arc::new(provider),
        runtime,
        plugins,
        NetworkClients::new(store),
        Default::default(),
    )
    .unwrap();
    (control::api_router(service), seen, address, directory)
}

async fn send(router: axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, String) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    let response = router
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn custom_tab_settings_round_trip_through_the_control_api() {
    let (router, _seen, _address, _directory) = setup().await;
    let (status, body) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/settings/tab",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let settings: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(settings["mode"], "direct");
    assert_eq!(settings["model"], "");

    let (status, body) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/tab",
        json!({
            "mode": "custom",
            "address": " https://tab.example.com/ ",
            "api_key": " tab-key ",
            "model": " qwen3-coder ",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let saved: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(saved["address"], "https://tab.example.com");
    assert_eq!(saved["api_key"], "tab-key");
    assert_eq!(saved["model"], "qwen3-coder");

    let (_, body) = send(router, "GET", "/__byok-api__/api/settings/tab", json!({})).await;
    let reloaded: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(reloaded["mode"], "custom");
    assert_eq!(reloaded["model"], "qwen3-coder");
}

#[tokio::test]
async fn custom_routing_requires_a_service_address() {
    let (router, _seen, _address, _directory) = setup().await;
    let (status, _) = send(
        router,
        "PUT",
        "/__byok-api__/api/settings/tab",
        json!({ "mode": "custom", "address": "  ", "api_key": "", "model": "" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn tab_model_discovery_reads_the_service_model_listing() {
    let (router, seen, address, _directory) = setup().await;
    let (status, body) = send(
        router,
        "POST",
        "/__byok-api__/api/settings/tab/models",
        json!({ "address": address, "api_key": "tab-key" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let models: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(models["models"], json!(["claude-tab", "qwen3-coder"]));
    assert_eq!(
        seen.0.lock().unwrap().last().cloned().flatten().as_deref(),
        Some("Bearer tab-key"),
        "the discovery request must carry the service key"
    );
}
