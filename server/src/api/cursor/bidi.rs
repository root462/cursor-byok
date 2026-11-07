//! Accepts ordered Cursor Bidi append requests and routes them by request_id.
use std::borrow::Cow;

use prost::Message;

use crate::{
    cursor::{
        conversation::TransportCommand,
        protocol::{
            events,
            proto::{agent::v1 as agent, aiserver::v1 as ai},
        },
        transport::{TransportParent, TransportRegistry},
    },
    Error, Result,
};

pub struct DecodedAppend {
    pub request_id: String,
    pub seqno: i64,
    pub message: agent::AgentClientMessage,
}

impl DecodedAppend {
    pub fn model_id(&self) -> Option<&str> {
        let agent::agent_client_message::Message::RunRequest(request) =
            self.message.message.as_ref()?
        else {
            return None;
        };
        request
            .requested_model
            .as_ref()
            .map(|model| model.model_id.as_str())
            .filter(|model| !model.is_empty())
            .or_else(|| {
                request
                    .model_details
                    .as_ref()
                    .map(|model| model.model_id.as_str())
                    .filter(|model| !model.is_empty())
            })
    }

    pub fn conversation_id(&self) -> Option<&str> {
        let agent::agent_client_message::Message::RunRequest(request) =
            self.message.message.as_ref()?
        else {
            return None;
        };
        request.conversation_id.as_deref()
    }

    pub fn is_background_task_completion(&self) -> bool {
        let Some(agent::agent_client_message::Message::RunRequest(request)) =
            self.message.message.as_ref()
        else {
            return false;
        };
        matches!(
            request
                .action
                .as_ref()
                .and_then(|action| action.action.as_ref()),
            Some(agent::conversation_action::Action::BackgroundTaskCompletionAction(_))
        )
    }

    pub fn trace_metadata(&self) -> serde_json::Value {
        let Some(message) = self.message.message.as_ref() else {
            return serde_json::json!({
                "append_seqno": self.seqno,
                "message_type": "empty",
            });
        };
        let agent::agent_client_message::Message::RunRequest(request) = message else {
            return serde_json::json!({
                "append_seqno": self.seqno,
                "message_type": client_message_type(message),
            });
        };
        let (action_type, history_messages, history_images) = request
            .action
            .as_ref()
            .and_then(|action| action.action.as_ref())
            .map(|action| match action {
                agent::conversation_action::Action::UserMessageAction(action) => {
                    let history = action.conversation_history.as_ref();
                    (
                        "user_message",
                        history.map_or(0, |history| history.messages.len()),
                        history.map_or(0, history_image_count),
                    )
                }
                agent::conversation_action::Action::BackgroundTaskCompletionAction(_) => {
                    ("background_task_completion", 0, 0)
                }
                agent::conversation_action::Action::ExecutePlanAction(_) => ("execute_plan", 0, 0),
                agent::conversation_action::Action::SummarizeAction(_) => ("summarize", 0, 0),
                _ => ("other", 0, 0),
            })
            .unwrap_or(("none", 0, 0));
        let state = request.conversation_state.as_ref();
        serde_json::json!({
            "append_seqno": self.seqno,
            "message_type": "run_request",
            "conversation_id": request.conversation_id,
            "model_id": self.model_id(),
            "action_type": action_type,
            "conversation_history_messages": history_messages,
            "conversation_history_images": history_images,
            "root_message_count": state.map_or(0, |state| state.root_prompt_messages_json.len()),
            "turn_count": state.map_or(0, |state| state.turns.len()),
            "prefetched_blob_count": request.pre_fetched_blobs.len(),
        })
    }
}

fn client_message_type(message: &agent::agent_client_message::Message) -> &'static str {
    use agent::agent_client_message::Message;
    match message {
        Message::RunRequest(_) => "run_request",
        Message::ExecClientMessage(_) => "exec_client_message",
        Message::ExecClientControlMessage(_) => "exec_client_control_message",
        Message::KvClientMessage(_) => "kv_client_message",
        Message::ConversationAction(_) => "conversation_action",
        Message::InteractionResponse(_) => "interaction_response",
        Message::ClientHeartbeat(_) => "client_heartbeat",
        Message::PrewarmRequest(_) => "prewarm_request",
    }
}

fn history_image_count(history: &agent::ConversationHistory) -> usize {
    use agent::{
        conversation_history_message::Message,
        conversation_history_tool_result_content::Content as ToolContent,
        conversation_history_user_content::Content as UserContent,
    };
    history
        .messages
        .iter()
        .map(|message| match message.message.as_ref() {
            Some(Message::User(user)) => user
                .content
                .iter()
                .filter(|content| matches!(content.content, Some(UserContent::Image(_))))
                .count(),
            Some(Message::Tool(tool)) => tool
                .content
                .iter()
                .filter(|content| matches!(content.content, Some(ToolContent::Image(_))))
                .count(),
            _ => 0,
        })
        .sum()
}

pub fn decode(request: &ai::BidiAppendRequest) -> Result<DecodedAppend> {
    let request_id = request
        .request_id
        .as_ref()
        .map(|id| id.request_id.as_str())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| Error::Protocol("BidiAppend request_id is required".into()))?;
    // Cursor sends the same raw AgentClientMessage protobuf as either hex data
    // or data_binary. Match the capture decoder's data-first precedence.
    let payload = if !request.data.is_empty() {
        Cow::Owned(
            hex::decode(&request.data)
                .map_err(|error| Error::Protocol(format!("invalid BidiAppend hex: {error}")))?,
        )
    } else if !request.data_binary.is_empty() {
        Cow::Borrowed(request.data_binary.as_slice())
    } else {
        return Err(Error::Protocol(
            "BidiAppend contains no AgentClientMessage".into(),
        ));
    };
    let message = match agent::AgentClientMessage::decode(payload.as_ref()) {
        Ok(message) => message,
        Err(_) if is_inference_run(&payload) => {
            return Err(Error::CursorRuntimeMismatch);
        }
        Err(error) => return Err(error.into()),
    };
    Ok(DecodedAppend {
        request_id: request_id.into(),
        seqno: request.append_seqno,
        message,
    })
}

// A diagnostic projection, not a second Agent runtime. Never reinterpret its
// conversation ID as ConversationStateStructure or manufacture missing history.
#[derive(Message)]
struct InferenceEnvelope {
    #[prost(message, optional, tag = "1")]
    run_request: Option<InferenceRun>,
}

#[derive(Message)]
struct InferenceRun {
    #[prost(string, tag = "1")]
    conversation_id: String,
    #[prost(message, optional, tag = "3")]
    requested_model: Option<InferenceModel>,
    #[prost(string, optional, tag = "5")]
    agent_mode: Option<String>,
    #[prost(bool, tag = "17")]
    supports_agent_loop_error: bool,
    #[prost(bool, tag = "18")]
    supports_delta_invocations: bool,
}

#[derive(Message)]
struct InferenceModel {
    #[prost(string, tag = "1")]
    model_id: String,
}

fn is_inference_run(payload: &[u8]) -> bool {
    if !has_unique_inference_fields(payload) {
        return false;
    }
    let Ok(envelope) = InferenceEnvelope::decode(payload) else {
        return false;
    };
    let Some(run) = envelope.run_request else {
        return false;
    };
    // These two bool fields have incompatible wire types in AgentRunRequest
    // (message and string). Cursor 3.29.9 sets both on every inference run.
    uuid::Uuid::try_parse(&run.conversation_id).is_ok()
        && run
            .requested_model
            .is_some_and(|model| !model.model_id.is_empty())
        && matches!(
            run.agent_mode.as_deref(),
            Some("agent" | "ask" | "plan" | "debug" | "multitask")
        )
        && run.supports_agent_loop_error
        && run.supports_delta_invocations
}

// Reject conflicting outer oneofs and duplicate discriminator fields. Prost
// normally merges duplicates, which is too permissive for protocol detection.
fn has_unique_inference_fields(payload: &[u8]) -> bool {
    use prost::encoding::{decode_key, decode_varint, skip_field, DecodeContext, WireType};
    let mut outer = payload;
    if decode_key(&mut outer).ok() != Some((1, WireType::LengthDelimited)) {
        return false;
    }
    let Ok(length) = decode_varint(&mut outer) else {
        return false;
    };
    if length != outer.len() as u64 {
        return false;
    }
    let mut seen = 0_u8;
    let mut run = outer;
    while !run.is_empty() {
        let Ok((tag, wire)) = decode_key(&mut run) else {
            return false;
        };
        let discriminator = match tag {
            1 => Some((1, WireType::LengthDelimited)),
            3 => Some((2, WireType::LengthDelimited)),
            5 => Some((4, WireType::LengthDelimited)),
            17 => Some((8, WireType::Varint)),
            18 => Some((16, WireType::Varint)),
            _ => None,
        };
        if let Some((bit, expected)) = discriminator {
            if seen & bit != 0 || wire != expected {
                return false;
            }
            seen |= bit;
        }
        if skip_field(wire, tag, &mut run, DecodeContext::default()).is_err() {
            return false;
        }
    }
    seen == 31
}

pub async fn append(
    registry: &TransportRegistry,
    request: DecodedAppend,
    parent: Option<TransportParent>,
) -> Result<ai::BidiAppendResponse> {
    let replace_closing = request.model_id().is_some();
    let handle = registry
        .get_or_create_for_append(&request.request_id, replace_closing)
        .await?;
    let _admission = handle.admit()?;
    if let Some(conversation_id) = request.conversation_id() {
        handle.set_conversation_id(conversation_id)?;
    }
    if let Some(parent) = parent {
        handle.set_parent(parent)?;
    }
    if matches!(
        request.message.message.as_ref(),
        Some(agent::agent_client_message::Message::ClientHeartbeat(_))
    ) {
        handle.emit(&events::heartbeat())?;
    }
    handle
        .command(TransportCommand::Append {
            seqno: request.seqno,
            message: Box::new(request.message),
        })
        .await?;
    Ok(ai::BidiAppendResponse {})
}
