//! Verifies captured Cursor Connect framing and protobuf compatibility.
#[path = "support/fake_cursor.rs"]
mod fake_cursor;
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{io::Write, sync::Arc, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use cursor_server::{
    api::cursor,
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::protocol::{
        connect,
        proto::{agent::v1 as pb, aiserver::v1 as ai},
    },
    cursor::transport::TransportRegistry,
    model::{ModelConfigInput, ModelType, OPENAI_CHAT_ENDPOINT},
    network::NetworkClients,
    provider::{FinishReason, ModelEvent},
};
use flate2::{write::GzEncoder, Compression};
use futures_util::StreamExt;
use prost::Message;
use tower::ServiceExt;

#[test]
fn connect_envelope_is_flag_plus_big_endian_length_plus_protobuf() {
    let message = pb::BidiRequestId {
        request_id: "abc".into(),
    };
    let frame = connect::encode_message(&message).unwrap();
    assert_eq!(&frame[..5], &[0, 0, 0, 0, 5]);
    let decoded: pb::BidiRequestId = fake_cursor::decode_single(&frame).unwrap();
    assert_eq!(decoded.request_id, "abc");
}

#[test]
fn end_stream_matches_captured_connect_shape() {
    assert_eq!(
        connect::encode_end_stream().as_ref(),
        &[2, 0, 0, 0, 2, b'{', b'}']
    );
}

#[test]
fn error_end_stream_is_flagged_json_not_protobuf() {
    let frame = connect::encode_error_end_stream(&connect::ConnectStreamError {
        code: connect::ConnectCode::Unavailable,
        message: "overloaded".into(),
        details: vec![connect::ConnectErrorDetail {
            type_name: "aiserver.v1.ErrorDetails".into(),
            value: "AQ".into(),
        }],
    })
    .unwrap();
    let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
    assert_eq!(flags, connect::END_STREAM_FLAG);
    let json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(json["error"]["code"], "unavailable");
    assert_eq!(json["error"]["message"], "overloaded");
    assert_eq!(
        json["error"]["details"][0]["type"],
        "aiserver.v1.ErrorDetails"
    );
}

#[test]
fn cursor_error_details_subset_decodes_captured_wire_value() {
    let captured = "CAISVQoUQXV0aGVudGljYXRpb24gZXJyb3ISMklmIHlvdSBhcmUgbG9nZ2VkIGluLCB0cnkgbG9nZ2luZyBvdXQgYW5kIGJhY2sgaW4uIABSBwoFbG9naW4YAQ";
    let bytes = STANDARD_NO_PAD.decode(captured).unwrap();
    let details = ai::ErrorDetails::decode(bytes.as_slice()).unwrap();
    assert_eq!(details.error, 2, "ERROR_NOT_LOGGED_IN");
    assert_eq!(details.is_expected, Some(true));
    let custom = details.details.unwrap();
    assert_eq!(custom.title, "Authentication error");
    assert_eq!(custom.is_retryable, Some(false));
}

#[test]
fn captured_kv_ack_hex_decodes_as_agent_client_message() {
    let bytes = hex::decode("1a0408011a00").unwrap();
    let message = pb::AgentClientMessage::decode(bytes.as_slice()).unwrap();
    let Some(pb::agent_client_message::Message::KvClientMessage(kv)) = message.message else {
        panic!("expected KV client message")
    };
    assert_eq!(kv.id, 1);
    assert!(matches!(
        kv.message,
        Some(pb::kv_client_message::Message::SetBlobResult(_))
    ));
}

#[test]
fn inference_run_requests_are_not_agent_messages() {
    // RunInferenceClientMessage.run_request = 1 and
    // RunInferenceRunRequest.conversation_id = 1. These tags collide with
    // AgentClientMessage.run_request and AgentRunRequest.conversation_state.
    #[derive(prost::Message)]
    struct InferenceRunRequest {
        #[prost(string, tag = "1")]
        conversation_id: String,
        #[prost(message, optional, tag = "3")]
        requested_model: Option<pb::RequestedModel>,
        #[prost(string, optional, tag = "5")]
        agent_mode: Option<String>,
    }
    #[derive(prost::Message)]
    struct InferenceClientMessage {
        #[prost(message, optional, tag = "1")]
        run_request: Option<InferenceRunRequest>,
    }
    for (conversation_id, field, cause) in [
        (
            "d6dbff7e-46d8-4539-afef-7d80801cec80",
            "file_states",
            "unexpected end group tag",
        ),
        (
            "564be75a-e2d5-41fb-a919-22731d463ddf",
            "summary",
            "invalid wire type: ThirtyTwoBit (expected LengthDelimited)",
        ),
    ] {
        let payload = InferenceClientMessage {
            run_request: Some(InferenceRunRequest {
                conversation_id: conversation_id.into(),
                requested_model: Some(pb::RequestedModel {
                    model_id: "fixture-model".into(),
                    ..Default::default()
                }),
                agent_mode: Some("agent".into()),
            }),
        }
        .encode_to_vec();
        let error = pb::AgentClientMessage::decode(payload.as_slice())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("ConversationStateStructure.{field}")),
            "{error}"
        );
        assert!(error.contains(cause), "{error}");
    }
}

fn append_request() -> ai::BidiAppendRequest {
    ai::BidiAppendRequest {
        request_id: Some(ai::BidiRequestId {
            request_id: "binary-request".into(),
        }),
        append_seqno: 7,
        ..Default::default()
    }
}

#[test]
fn bidi_append_decodes_binary_and_hex_agent_messages() {
    // Captured KV acknowledgement, without Connect framing or text encoding.
    let payload = hex::decode("1a0408011a00").unwrap();
    for binary in [false, true] {
        let mut request = append_request();
        if binary {
            request.data_binary = payload.clone();
        } else {
            request.data = hex::encode(&payload);
        }
        let decoded = cursor::bidi::decode(&request).unwrap();
        assert_eq!(decoded.request_id, "binary-request");
        assert_eq!(decoded.seqno, 7);
        assert_eq!(
            decoded.message,
            pb::AgentClientMessage::decode(payload.as_slice()).unwrap()
        );
    }
}

#[test]
fn bidi_append_uses_hex_data_when_both_payload_fields_are_present() {
    let mut request = append_request();
    request.data = "1a0408011a00".into();
    request.data_binary = vec![0xff];
    assert!(matches!(
        cursor::bidi::decode(&request).unwrap().message.message,
        Some(pb::agent_client_message::Message::KvClientMessage(_))
    ));

    request.data = "not hex".into();
    request.data_binary = hex::decode("1a0408011a00").unwrap();
    assert!(cursor::bidi::decode(&request)
        .err()
        .unwrap()
        .to_string()
        .contains("invalid BidiAppend hex"));
}

#[test]
fn bidi_append_requires_a_request_id_for_binary_payloads() {
    for request_id in [None, Some(ai::BidiRequestId::default())] {
        let request = ai::BidiAppendRequest {
            request_id,
            data_binary: hex::decode("1a0408011a00").unwrap(),
            ..Default::default()
        };
        assert!(cursor::bidi::decode(&request)
            .err()
            .unwrap()
            .to_string()
            .contains("BidiAppend request_id is required"));
    }
}

#[test]
fn bidi_append_rejects_missing_payload_and_malformed_protobuf() {
    let mut request = append_request();
    assert!(cursor::bidi::decode(&request)
        .err()
        .unwrap()
        .to_string()
        .contains("BidiAppend contains no AgentClientMessage"));

    request.data_binary = vec![0xff];
    assert!(matches!(
        cursor::bidi::decode(&request),
        Err(cursor_server::Error::Decode(_))
    ));
    request.data_binary.clear();
    request.data = "not hex".into();
    assert!(cursor::bidi::decode(&request)
        .err()
        .unwrap()
        .to_string()
        .contains("invalid BidiAppend hex"));
}

async fn post_binary_append(app: &axum::Router, seqno: i64, message: pb::AgentClientMessage) {
    let mut request = append_request();
    request.append_seqno = seqno;
    request.data_binary = message.encode_to_vec();
    // Exercise gzip decompression as well as the outer and inner protobufs.
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&request.encode_to_vec()).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::post("/aiserver.v1.BidiService/BidiAppend")
                .header(header::CONTENT_TYPE, "application/proto")
                .header(header::CONTENT_ENCODING, "gzip")
                .body(Body::from(encoder.finish().unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
}

#[tokio::test]
async fn binary_bidi_append_completes_a_run_with_binary_kv_acknowledgements() {
    let (_directory, store) = fixtures::temp_store().await;
    let model = store
        .create_model(
            &serde_json::from_value::<ModelConfigInput>(serde_json::json!({
                "display_name": "Binary wire test",
                "type": ModelType::OpenAi,
                "base_url": "http://127.0.0.1:1",
                "api_key": "unused",
                "tooltip_data": "Binary protocol regression test",
                "model_id": "wire-test-model",
                "openai_endpoint": OPENAI_CHAT_ENDPOINT
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "binary-call".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("binary response".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let app = cursor::router(registry.clone(), NetworkClients::new(store)).unwrap();
    let message = pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                conversation_id: Some("binary-conversation".into()),
                run_id: Some("binary-run".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: model.model_hash,
                    ..Default::default()
                }),
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "hello".into(),
                                message_id: "binary-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    };
    // Cursor starts RunSSE before sending the first append. The binary RunRequest
    // must establish the route and release this pending HTTP response.
    let run_sse = app.clone().oneshot(
        Request::post("/agent.v1.AgentService/RunSSE")
            .header(header::CONTENT_TYPE, "application/proto")
            .body(Body::from(
                pb::BidiRequestId {
                    request_id: "binary-request".into(),
                }
                .encode_to_vec(),
            ))
            .unwrap(),
    );
    tokio::pin!(run_sse);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut run_sse)
            .await
            .is_err()
    );
    post_binary_append(&app, 0, message).await;
    let response = tokio::time::timeout(Duration::from_secs(5), run_sse)
        .await
        .expect("binary append did not establish the RunSSE route")
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut output = response.into_body().into_data_stream();
    post_binary_append(
        &app,
        1,
        pb::AgentClientMessage {
            message: Some(pb::agent_client_message::Message::ClientHeartbeat(
                pb::ClientHeartbeat {},
            )),
        },
    )
    .await;
    let mut seqno = 2;
    let mut saw_heartbeat = false;
    let mut saw_text = false;
    let mut saw_checkpoint = false;
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), output.next())
            .await
            .expect("binary RunSSE stalled")
            .expect("RunSSE closed before EndStream")
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            let terminal: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            assert!(terminal.get("error").is_none(), "{terminal}");
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                post_binary_append(
                    &app,
                    seqno,
                    pb::AgentClientMessage {
                        message: Some(pb::agent_client_message::Message::KvClientMessage(
                            pb::KvClientMessage {
                                id: kv.id,
                                message: Some(pb::kv_client_message::Message::SetBlobResult(
                                    pb::SetBlobResult { error: None },
                                )),
                            },
                        )),
                    },
                )
                .await;
                seqno += 1;
            }
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(_)) => {
                saw_checkpoint = true;
            }
            Some(pb::agent_server_message::Message::InteractionUpdate(update)) => {
                match update.message {
                    Some(pb::interaction_update::Message::TextDelta(delta)) => {
                        saw_text |= delta.text == "binary response";
                    }
                    Some(pb::interaction_update::Message::Heartbeat(_)) => saw_heartbeat = true,
                    _ => {}
                }
            }
            _ => {}
        }
    }
    assert!(saw_text, "model response must reach Cursor");
    assert!(saw_checkpoint, "run must commit its checkpoint");
    assert!(
        saw_heartbeat,
        "binary heartbeats must keep the transport alive"
    );
    assert!(seqno > 2, "binary KV acknowledgements must be exercised");
    assert_eq!(provider.requests().len(), 1);
    registry.shutdown().await;
}

#[tokio::test]
async fn bidi_append_gzip_body_is_decompressed_before_protobuf_decode() {
    let (_directory, store) = fixtures::temp_store().await;
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let clients = NetworkClients::new(store.clone());
    let registry = TransportRegistry::new(
        store,
        Arc::new(fake_provider::FakeProvider::default()),
        PromptCompiler::new(assets),
    );
    let wire = ai::BidiAppendRequest {
        request_id: Some(ai::BidiRequestId {
            request_id: "gzip-request".into(),
        }),
        ..Default::default()
    }
    .encode_to_vec();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&wire).unwrap();
    let compressed = encoder.finish().unwrap();

    let response = cursor::router(registry, clients)
        .unwrap()
        .oneshot(
            Request::post("/aiserver.v1.BidiService/BidiAppend")
                .header(header::CONTENT_TYPE, "application/proto")
                .header(header::CONTENT_ENCODING, "gzip")
                .body(Body::from(compressed))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let text = std::str::from_utf8(&body).unwrap();
    assert!(text.contains("BidiAppend contains no AgentClientMessage"));
    assert!(!text.contains("protobuf decode error"));
}
