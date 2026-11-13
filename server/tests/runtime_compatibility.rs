//! Detects local-loop requests without translating or overwriting conversation state.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{sync::Arc, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use cursor_server::{
    api::cursor,
    control::{self, ControlService},
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        protocol::{
            connect,
            proto::{agent::v1 as pb, aiserver::v1 as ai},
        },
        transport::{TransportRegistry, TransportRoute},
    },
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    Error,
};
use prost::Message;
use tower::ServiceExt;

// Captured discriminator fields from Cursor 3.29.9, not an implementation of
// inference. Model credentials and conversation contents are deliberately absent.
#[derive(Message)]
struct InferenceRun {
    #[prost(string, tag = "1")]
    conversation_id: String,
    #[prost(message, optional, tag = "3")]
    requested_model: Option<pb::RequestedModel>,
    #[prost(string, optional, tag = "5")]
    agent_mode: Option<String>,
    #[prost(bool, tag = "17")]
    supports_agent_loop_error: bool,
    #[prost(bool, tag = "18")]
    supports_delta_invocations: bool,
}

#[derive(Message)]
struct InferenceClient {
    #[prost(message, optional, tag = "1")]
    run_request: Option<InferenceRun>,
}

fn inference() -> InferenceClient {
    InferenceClient {
        run_request: Some(InferenceRun {
            conversation_id: "d6dbff7e-46d8-4539-afef-7d80801cec80".into(),
            requested_model: Some(pb::RequestedModel {
                model_id: "local-model".into(),
                ..Default::default()
            }),
            agent_mode: Some("agent".into()),
            supports_agent_loop_error: true,
            supports_delta_invocations: true,
        }),
    }
}

fn append(payload: Vec<u8>, binary: bool) -> ai::BidiAppendRequest {
    ai::BidiAppendRequest {
        request_id: Some(ai::BidiRequestId {
            request_id: "runtime-request".into(),
        }),
        data: if binary {
            String::new()
        } else {
            hex::encode(&payload)
        },
        data_binary: if binary { payload } else { vec![] },
        ..Default::default()
    }
}

#[test]
fn inference_requires_all_unambiguous_discriminators_in_both_encodings() {
    for binary in [false, true] {
        assert!(matches!(
            cursor::bidi::decode(&append(inference().encode_to_vec(), binary)),
            Err(Error::CursorRuntimeMismatch)
        ));
    }
    for missing in 0..5 {
        let mut message = inference();
        let run = message.run_request.as_mut().unwrap();
        match missing {
            0 => run.conversation_id = "not-a-uuid".into(),
            1 => run.requested_model = None,
            2 => run.agent_mode = Some("unknown-mode".into()),
            3 => run.supports_agent_loop_error = false,
            _ => run.supports_delta_invocations = false,
        }
        assert!(
            !matches!(
                cursor::bidi::decode(&append(message.encode_to_vec(), true)),
                Err(Error::CursorRuntimeMismatch)
            ),
            "missing discriminator {missing}"
        );
    }
    let payload = inference().encode_to_vec();
    for length in 0..payload.len() {
        assert!(
            !matches!(
                cursor::bidi::decode(&append(payload[..length].to_vec(), true)),
                Err(Error::CursorRuntimeMismatch)
            ),
            "truncated at {length}"
        );
    }
}

#[test]
fn conflicts_and_ordinary_agent_messages_do_not_trigger_runtime_repair() {
    let payload = inference().encode_to_vec();
    let mut conflicting = payload.clone();
    conflicting.extend_from_slice(&[0x3a, 0]); // A different outer oneof message.
    assert!(!matches!(
        cursor::bidi::decode(&append(conflicting, true)),
        Err(Error::CursorRuntimeMismatch)
    ));
    let mut duplicate = payload;
    duplicate.extend_from_slice(&inference().encode_to_vec());
    assert!(!matches!(
        cursor::bidi::decode(&append(duplicate, true)),
        Err(Error::CursorRuntimeMismatch)
    ));
    let ordinary = pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                conversation_id: Some("d6dbff7e-46d8-4539-afef-7d80801cec80".into()),
                conversation_state: Some(pb::ConversationStateStructure {
                    root_prompt_messages_json: vec![b"history stays unchanged".to_vec()],
                    ..Default::default()
                }),
                requested_model: Some(pb::RequestedModel {
                    model_id: "local-model".into(),
                    ..Default::default()
                }),
                dev_raw_model_slug: Some("agent".into()),
                ..Default::default()
            },
        )),
    };
    assert_eq!(
        cursor::bidi::decode(&append(ordinary.encode_to_vec(), true))
            .unwrap()
            .message,
        ordinary
    );
    assert!(matches!(
        cursor::bidi::decode(&append(vec![0xff], true)),
        Err(Error::Decode(_))
    ));
}

// Encode individual fields so duplicate/wrong-wire tests do not depend on
// byte offsets or prost's normal last-value-wins/merge behavior.
fn inference_discriminators() -> [(u32, Vec<u8>); 5] {
    let run = inference().run_request.unwrap();
    let mut fields = [
        (1, vec![]),
        (3, vec![]),
        (5, vec![]),
        (17, vec![]),
        (18, vec![]),
    ];
    prost::encoding::string::encode(1, &run.conversation_id, &mut fields[0].1);
    prost::encoding::message::encode(3, &run.requested_model.unwrap(), &mut fields[1].1);
    prost::encoding::string::encode(5, &run.agent_mode.unwrap(), &mut fields[2].1);
    prost::encoding::bool::encode(17, &true, &mut fields[3].1);
    prost::encoding::bool::encode(18, &true, &mut fields[4].1);
    fields
}

fn inference_envelope(run: &[u8]) -> Vec<u8> {
    let mut envelope = vec![];
    prost::encoding::bytes::encode(1, &run.to_vec(), &mut envelope);
    envelope
}

#[test]
fn duplicate_discriminators_never_trigger_runtime_repair_even_when_prost_accepts_them() {
    let run = inference().run_request.unwrap().encode_to_vec();
    for (tag, field) in inference_discriminators() {
        for duplicate_first in [false, true] {
            let duplicate = if duplicate_first {
                [field.as_slice(), run.as_slice()].concat()
            } else {
                [run.as_slice(), field.as_slice()].concat()
            };
            let payload = inference_envelope(&duplicate);
            // All discriminators would pass if detection simply decoded/merged.
            assert_eq!(
                InferenceClient::decode(payload.as_slice())
                    .unwrap()
                    .run_request
                    .unwrap()
                    .encode_to_vec(),
                run
            );
            for binary in [false, true] {
                assert!(
                    !matches!(
                        cursor::bidi::decode(&append(payload.clone(), binary)),
                        Err(Error::CursorRuntimeMismatch)
                    ),
                    "duplicate tag {tag}, duplicate_first={duplicate_first}, binary={binary}"
                );
            }
        }
    }
}

#[test]
fn wrong_wire_discriminators_and_malformed_unknown_fields_remain_decode_errors() {
    for invalid_tag in [1, 3, 5, 17, 18] {
        let mut run = vec![];
        for (tag, field) in inference_discriminators() {
            if tag != invalid_tag {
                run.extend_from_slice(&field);
            } else if tag < 17 {
                prost::encoding::bool::encode(tag, &true, &mut run);
            } else {
                prost::encoding::string::encode(tag, &"wrong-wire".to_string(), &mut run);
            }
        }
        for binary in [false, true] {
            assert!(
                matches!(
                    cursor::bidi::decode(&append(inference_envelope(&run), binary)),
                    Err(Error::Decode(_))
                ),
                "wrong wire tag {invalid_tag}, binary={binary}"
            );
        }
    }
    let run = inference().run_request.unwrap().encode_to_vec();
    // Unknown fields are allowed only when their wire payload is well formed.
    for malformed in [
        vec![0x00],
        vec![0xfa, 0x01, 0x02, 0x01],
        vec![0xf8, 0x01, 0x80],
    ] {
        let mut corrupted = run.clone();
        corrupted.extend_from_slice(&malformed);
        for binary in [false, true] {
            assert!(matches!(
                cursor::bidi::decode(&append(inference_envelope(&corrupted), binary)),
                Err(Error::Decode(_))
            ));
        }
    }
    let mut extended = run;
    prost::encoding::string::encode(31, &"unknown but valid".to_string(), &mut extended);
    for binary in [false, true] {
        assert!(matches!(
            cursor::bidi::decode(&append(inference_envelope(&extended), binary)),
            Err(Error::CursorRuntimeMismatch)
        ));
    }
}

async fn setup() -> (
    tempfile::TempDir,
    TransportRegistry,
    fake_provider::FakeProvider,
    axum::Router,
) {
    let (dir, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    let assets =
        PromptAssets::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("prompt/cursor"))
            .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let clients = NetworkClients::new(store.clone());
    // Match App::new: both routers must own clones of the registry's actual
    // RuntimeCompatibility, not independent default instances.
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "0.1.0".into()).unwrap();
    let control = ControlService::new(
        store,
        Default::default(),
        Arc::new(provider.clone()),
        runtime,
        plugins,
        clients.clone(),
        registry.runtime_compatibility().clone(),
    )
    .unwrap();
    let app = cursor::router(registry.clone(), clients)
        .unwrap()
        .merge(control::api_router(control));
    (dir, registry, provider, app)
}

fn assert_denial(error: &serde_json::Value) {
    // Cursor matches the raw string exactly. Never append translated guidance
    // or echo request contents/credentials in optional error details.
    assert_eq!(
        error,
        &serde_json::json!({
            "code": "permission_denied",
            "message": "InferenceService.RunInference is not enabled for this account"
        })
    );
}

async fn denial(response: axum::response::Response) {
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_denial(&serde_json::from_slice(&body).unwrap());
}

async fn stream_denial(response: axum::response::Response) {
    // All three explicit Inference methods are streaming in Cursor 3.29.9.
    // Its validateResponse rejects non-200 before reading a JSON error body,
    // losing the raw message required by isLocalLoopEnrollmentDenial.
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/connect+proto"
    );
    assert_eq!(response.headers()["connect-protocol-version"], "1");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let frames = connect::decode_frames(&body).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].0, connect::END_STREAM_FLAG);
    let end: serde_json::Value = serde_json::from_slice(&frames[0].1).unwrap();
    assert_eq!(end.as_object().unwrap().len(), 1);
    assert_denial(&end["error"]);
}

async fn runtime_status(app: &axum::Router) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(
            Request::get("/__byok-api__/api/harness/cursor/runtime-status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn control_runtime_status_shares_cursor_rejections_without_exposing_request_data() {
    let (_dir, registry, provider, app) = setup().await;
    assert_eq!(
        runtime_status(&app).await,
        serde_json::json!({"mismatch_count": 0, "last_detected_at_ms": null})
    );
    // Synthetic sentinels, never real user credentials or history. An unknown
    // inference field carries private content which must not reach diagnostics.
    let mut run = inference().run_request.unwrap();
    run.requested_model.as_mut().unwrap().model_id = "private-model-sentinel".into();
    let mut run_bytes = run.encode_to_vec();
    prost::encoding::string::encode(31, &"private-conversation-sentinel".into(), &mut run_bytes);
    let payload = append(inference_envelope(&run_bytes), true).encode_to_vec();
    let mut last_detected_at_ms = 0;
    for (index, path) in [
        "/aiserver.v1.BidiService/BidiAppend",
        "/aiserver.v1.InferenceService/RunInference",
        "/aiserver.v1.InferenceService/RunInferenceSSE",
        "/aiserver.v1.InferenceService/RunInferencePoll",
    ]
    .into_iter()
    .enumerate()
    {
        let before = chrono::Utc::now().timestamp_millis();
        let response = app
            .clone()
            .oneshot(
                Request::post(path)
                    .header(
                        header::CONTENT_TYPE,
                        if index == 0 {
                            "application/proto"
                        } else {
                            "application/connect+proto"
                        },
                    )
                    .header("connect-protocol-version", "1")
                    .header(header::AUTHORIZATION, "Bearer fake-credential-sentinel")
                    .header(header::COOKIE, "session=fake-cookie-sentinel")
                    .body(Body::from(payload.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        if index == 0 {
            denial(response).await;
        } else {
            stream_denial(response).await;
        }
        let after = chrono::Utc::now().timestamp_millis();
        let status = runtime_status(&app).await;
        let detected = status["last_detected_at_ms"].as_i64().unwrap();
        assert!((before..=after).contains(&detected));
        assert!(detected >= last_detected_at_ms);
        last_detected_at_ms = detected;
        // Exact schema: no request body, request/conversation/model IDs, tokens,
        // headers, or credentials, including optional error-detail objects.
        assert_eq!(
            status,
            serde_json::json!({
                "mismatch_count": index + 1,
                "last_detected_at_ms": detected
            })
        );
        assert_eq!(
            runtime_status(&app).await,
            status,
            "GET must not reset diagnostics"
        );
    }
    assert!(provider.requests().is_empty());
    assert!(registry.local("runtime-request").await.is_none());
    assert!(!registry.upstream("runtime-request").await);
    registry.shutdown().await;
}

#[tokio::test]
async fn explicit_inference_rpcs_return_the_client_reroute_signal_without_upstream_calls() {
    let (_dir, registry, provider, app) = setup().await;
    for path in ["RunInference", "RunInferenceSSE", "RunInferencePoll"] {
        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/aiserver.v1.InferenceService/{path}"))
                    .header(header::CONTENT_TYPE, "application/connect+proto")
                    .header("connect-protocol-version", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        stream_denial(response).await;
    }
    assert_eq!(registry.runtime_compatibility().status().mismatch_count, 3);
    assert!(provider.requests().is_empty());
    registry.shutdown().await;
}

#[tokio::test]
async fn rejected_append_releases_pending_or_late_downstream_and_allows_a_fresh_agent_route() {
    for downstream_first in [false, true] {
        let (_dir, registry, provider, app) = setup().await;
        let downstream = app.clone().oneshot(
            Request::post("/agent.v1.AgentService/RunSSE")
                .header(header::CONTENT_TYPE, "application/proto")
                .body(Body::from(
                    pb::BidiRequestId {
                        request_id: "runtime-request".into(),
                    }
                    .encode_to_vec(),
                ))
                .unwrap(),
        );
        tokio::pin!(downstream);
        if downstream_first {
            assert!(
                tokio::time::timeout(Duration::from_millis(25), &mut downstream)
                    .await
                    .is_err()
            );
        }
        let response = app
            .clone()
            .oneshot(
                Request::post("/aiserver.v1.BidiService/BidiAppend")
                    .header(header::CONTENT_TYPE, "application/proto")
                    .body(Body::from(
                        append(inference().encode_to_vec(), true).encode_to_vec(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        denial(response).await;
        let response = tokio::time::timeout(Duration::from_secs(2), downstream)
            .await
            .expect("rejected runtime must not leave RunSSE waiting")
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let frames = connect::decode_frames(&body).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0, connect::END_STREAM_FLAG);
        let end: serde_json::Value = serde_json::from_slice(&frames[0].1).unwrap();
        assert_eq!(end["error"]["code"], "permission_denied");
        assert_eq!(
            end["error"]["message"],
            "InferenceService.RunInference is not enabled for this account"
        );
        assert!(provider.requests().is_empty());
        assert!(registry.local("runtime-request").await.is_none());
        assert!(!registry.upstream("runtime-request").await);
        // The rejection is request-scoped, not a permanent ban on the old
        // conversation or on a corrected Agent retry using the same request ID.
        registry.get_or_create("runtime-request").await.unwrap();
        assert_eq!(
            registry.wait_route("runtime-request").await,
            TransportRoute::Local
        );
        registry.shutdown().await;
    }
}
