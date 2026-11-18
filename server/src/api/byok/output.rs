use std::{
    collections::{BTreeMap, HashSet},
    convert::Infallible,
};

use axum::{
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    model::Usage,
    provider::{FinishReason, ModelEvent, ProviderStream},
    Error, Result,
};

use super::protocol::Protocol;

#[derive(Default)]
struct ToolOutput {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct Output {
    text: String,
    thinking: String,
    tools: BTreeMap<usize, ToolOutput>,
    usage: Option<Usage>,
    finish: Option<FinishReason>,
}

impl Output {
    fn update(&mut self, event: &ModelEvent) {
        match event {
            ModelEvent::TextDelta(delta) => self.text.push_str(delta),
            ModelEvent::ThinkingDelta(delta) => self.thinking.push_str(delta),
            ModelEvent::ToolCallStart {
                index,
                call_id,
                name,
            } => {
                self.tools.insert(
                    *index,
                    ToolOutput {
                        id: call_id.clone(),
                        name: name.clone(),
                        arguments: String::new(),
                    },
                );
            }
            ModelEvent::ToolCallArgumentsDelta { index, delta } => {
                if let Some(tool) = self.tools.get_mut(index) {
                    tool.arguments.push_str(delta);
                }
            }
            ModelEvent::Usage(usage) => self.usage = Some(*usage),
            ModelEvent::Done(reason) => self.finish = Some(*reason),
            _ => {}
        }
    }

    fn json(&self, protocol: Protocol, id: &str, model: &str) -> Value {
        let usage = self.usage_json(protocol);
        let finish = match self.finish.unwrap_or(FinishReason::Stop) {
            FinishReason::Stop => "stop",
            FinishReason::Length => "length",
            FinishReason::ToolUse => "tool_calls",
        };
        match protocol {
            Protocol::Chat => json!({"id":id,"object":"chat.completion","created":0,"model":model,
                "choices":[{"index":0,"message":{"role":"assistant","content":self.text,
                    "tool_calls":self.tools.values().map(|tool| json!({"id":tool.id,"type":"function",
                        "function":{"name":tool.name,"arguments":tool.arguments}})).collect::<Vec<_>>()},"finish_reason":finish}],
                "usage":usage}),
            Protocol::Responses => {
                let mut items = Vec::new();
                if !self.text.is_empty() {
                    items.push(json!({"id":format!("msg_{id}"),"type":"message","status":"completed",
                    "role":"assistant","content":[{"type":"output_text","text":self.text,"annotations":[]}]}));
                }
                items.extend(self.tools.values().map(|tool| json!({"type":"function_call","id":format!("fc_{}",tool.id),
                    "call_id":tool.id,"name":tool.name,"arguments":tool.arguments,"status":"completed"})));
                json!({"id":id,"object":"response","created_at":0,"status":"completed","model":model,
                    "output":items,"output_text":self.text,
                    "usage":usage})
            }
            Protocol::Messages => {
                let mut content = Vec::new();
                if !self.thinking.is_empty() {
                    content.push(json!({"type":"thinking","thinking":self.thinking,"signature":""}));
                }
                if !self.text.is_empty() {
                    content.push(json!({"type":"text","text":self.text}));
                }
                content.extend(self.tools.values().map(|tool| {
                    json!({"type":"tool_use","id":tool.id,"name":tool.name,
                    "input":serde_json::from_str::<Value>(&tool.arguments).unwrap_or(json!({}))})
                }));
                json!({"id":id,"type":"message","role":"assistant","model":model,"content":content,
                    "stop_reason":if self.tools.is_empty() { match self.finish { Some(FinishReason::Length) => "max_tokens", _ => "end_turn" } } else { "tool_use" },
                    "stop_sequence":null,"usage":usage})
            }
        }
    }

    fn usage_json(&self, protocol: Protocol) -> Value {
        let usage = self.usage.unwrap_or_default();
        let input = usage
            .context_input_tokens
            .or(usage.input_tokens)
            .unwrap_or(0);
        let output = usage.output_tokens.unwrap_or(0);
        match protocol {
            Protocol::Chat => {
                let mut value = json!({"prompt_tokens":input,"completion_tokens":output,
                    "total_tokens":usage.total_tokens.unwrap_or(input.saturating_add(output))});
                if let Some(cached) = usage.cache_read_tokens {
                    value["prompt_tokens_details"] = json!({"cached_tokens":cached});
                }
                if let Some(reasoning) = usage.reasoning_tokens {
                    value["completion_tokens_details"] = json!({"reasoning_tokens":reasoning});
                }
                value
            }
            Protocol::Responses => {
                let mut value = json!({"input_tokens":input,"output_tokens":output,
                    "total_tokens":usage.total_tokens.unwrap_or(input.saturating_add(output))});
                if let Some(cached) = usage.cache_read_tokens {
                    value["input_tokens_details"] = json!({"cached_tokens":cached});
                }
                if let Some(reasoning) = usage.reasoning_tokens {
                    value["output_tokens_details"] = json!({"reasoning_tokens":reasoning});
                }
                value
            }
            Protocol::Messages => {
                let uncached =
                    usage
                        .context_input_tokens
                        .map_or(usage.input_tokens.unwrap_or(0), |total| {
                            total
                                .saturating_sub(usage.cache_read_tokens.unwrap_or(0))
                                .saturating_sub(usage.cache_write_tokens.unwrap_or(0))
                        });
                let mut value = json!({"input_tokens":uncached,"output_tokens":output});
                if let Some(cached) = usage.cache_read_tokens {
                    value["cache_read_input_tokens"] = json!(cached);
                }
                if let Some(written) = usage.cache_write_tokens {
                    value["cache_creation_input_tokens"] = json!(written);
                }
                value
            }
        }
    }
}

pub(crate) async fn complete(
    protocol: Protocol,
    mut stream: ProviderStream,
    id: &str,
    model: &str,
) -> Result<Json<Value>> {
    let mut output = Output::default();
    while let Some(event) = stream.next().await {
        output.update(&event?);
    }
    if output.finish.is_none() {
        return Err(Error::Provider(
            "model stream ended without completion".into(),
        ));
    }
    Ok(Json(output.json(protocol, id, model)))
}

struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Assigns Anthropic Messages content-block indexes as blocks open.
///
/// Upstream events arrive in the order thinking -> text -> tools, and the
/// Messages protocol requires every `content_block_start` to take the next
/// unused index and every delta to target an open block. Deriving indexes from
/// whether text had started is wrong once reasoning streams are present: the
/// indexes collide and the client rejects the stream as malformed.
#[derive(Default)]
struct BlockIndexes {
    next: usize,
    thinking: Option<usize>,
    text: Option<usize>,
    tools: std::collections::BTreeMap<usize, usize>,
}

impl BlockIndexes {
    fn open(&mut self) -> usize {
        let index = self.next;
        self.next += 1;
        index
    }
}

pub(crate) fn streamed(
    protocol: Protocol,
    mut provider: ProviderStream,
    cancellation: CancellationToken,
    id: String,
    model: String,
) -> Response {
    let events = async_stream::stream! {
        let _cancel = CancelOnDrop(cancellation);
        let mut output = Output::default();
        if matches!(protocol, Protocol::Chat) {
            yield Ok::<Event, Infallible>(Event::default().data(chat_chunk(&id, &model, json!({"role":"assistant"}), Value::Null).to_string()));
        } else if matches!(protocol, Protocol::Responses) {
            yield Ok(Event::default().event("response.created").data(json!({"type":"response.created","response":{"id":id,"status":"in_progress","model":model}}).to_string()));
            yield Ok(Event::default().event("response.in_progress").data(json!({"type":"response.in_progress","response":{"id":id,"status":"in_progress","model":model}}).to_string()));
        } else {
            yield Ok(Event::default().event("message_start").data(json!({"type":"message_start","message":{"id":id,"type":"message","role":"assistant","model":model,"content":[],"usage":{"input_tokens":0,"output_tokens":0}}}).to_string()));
        }
        let mut blocks = BlockIndexes::default();
        let mut text_started = false;
        let mut text_closed = false;
        let mut closed_tools = HashSet::new();
        while let Some(result) = provider.next().await {
            match result {
                Ok(event) => {
                    if matches!(event, ModelEvent::TextDelta(_)) && !text_started && !matches!(protocol, Protocol::Chat) {
                        for (name, value) in stream_events(protocol, &ModelEvent::TextStart, &id, &model, &output, &mut text_started, &mut blocks) {
                            yield Ok(Event::default().event(name).data(value.to_string()));
                        }
                    }
                    if matches!(event, ModelEvent::Done(_)) {
                        if text_started && !text_closed {
                            for (name, value) in stream_events(protocol, &ModelEvent::TextEnd, &id, &model, &output, &mut text_started, &mut blocks) {
                                yield Ok(Event::default().event(name).data(value.to_string()));
                            }
                        }
                        for index in output.tools.keys().filter(|index| !closed_tools.contains(*index)).copied().collect::<Vec<_>>() {
                            for (name, value) in stream_events(protocol, &ModelEvent::ToolCallEnd { index }, &id, &model, &output, &mut text_started, &mut blocks) {
                                yield Ok(Event::default().event(name).data(value.to_string()));
                            }
                        }
                    }
                    output.update(&event);
                    for (name, value) in stream_events(protocol, &event, &id, &model, &output, &mut text_started, &mut blocks) {
                        yield Ok(Event::default().event(name).data(value.to_string()));
                    }
                    if matches!(event, ModelEvent::TextEnd | ModelEvent::Done(_)) {
                        text_closed = true;
                    }
                    if let ModelEvent::ToolCallEnd { index } = event {
                        closed_tools.insert(index);
                    }
                }
                Err(error) => {
                    yield Ok(Event::default().event("error").data(json!({"error":{"message":error.to_string(),"type":"upstream_error"}}).to_string()));
                    return;
                }
            }
        }
        if output.finish.is_some() && matches!(protocol, Protocol::Chat) {
            yield Ok(Event::default().data("[DONE]"));
        }
    };
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn chat_chunk(id: &str, model: &str, delta: Value, finish: Value) -> Value {
    json!({"id":id,"object":"chat.completion.chunk","created":0,"model":model,
        "choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
}

fn stream_events(
    protocol: Protocol,
    event: &ModelEvent,
    id: &str,
    model: &str,
    output: &Output,
    text_started: &mut bool,
    blocks: &mut BlockIndexes,
) -> Vec<(&'static str, Value)> {
    match protocol {
        Protocol::Chat => match event {
            ModelEvent::TextDelta(delta) => vec![(
                "message",
                chat_chunk(id, model, json!({"content":delta}), Value::Null),
            )],
            ModelEvent::ToolCallStart {
                index,
                call_id,
                name,
            } => vec![(
                "message",
                chat_chunk(
                    id,
                    model,
                    json!({"tool_calls":[{"index":index,"id":call_id,"type":"function","function":{"name":name,"arguments":""}}]}),
                    Value::Null,
                ),
            )],
            ModelEvent::ToolCallArgumentsDelta { index, delta } => vec![(
                "message",
                chat_chunk(
                    id,
                    model,
                    json!({"tool_calls":[{"index":index,"function":{"arguments":delta}}]}),
                    Value::Null,
                ),
            )],
            ModelEvent::Done(reason) => {
                let finish = match reason {
                    FinishReason::Stop => "stop",
                    FinishReason::Length => "length",
                    FinishReason::ToolUse => "tool_calls",
                };
                let mut events = vec![("message", chat_chunk(id, model, json!({}), json!(finish)))];
                if output.usage.is_some() {
                    events.push((
                        "message",
                        json!({"id":id,"object":"chat.completion.chunk","created":0,"model":model,
                            "choices":[],"usage":output.usage_json(protocol)}),
                    ));
                }
                events
            }
            _ => Vec::new(),
        },
        Protocol::Responses => match event {
            ModelEvent::TextStart if !*text_started => {
                *text_started = true;
                let item_id = format!("msg_{id}");
                vec![
                    (
                        "response.output_item.added",
                        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":item_id,"status":"in_progress","role":"assistant","content":[]}}),
                    ),
                    (
                        "response.content_part.added",
                        json!({"type":"response.content_part.added","item_id":item_id,"output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
                    ),
                ]
            }
            ModelEvent::TextDelta(delta) => {
                let item_id = format!("msg_{id}");
                vec![(
                    "response.output_text.delta",
                    json!({"type":"response.output_text.delta","item_id":item_id,"delta":delta,"output_index":0,"content_index":0}),
                )]
            }
            ModelEvent::TextEnd if *text_started => {
                let item_id = format!("msg_{id}");
                vec![
                    (
                        "response.output_text.done",
                        json!({"type":"response.output_text.done","item_id":item_id,"text":output.text,"output_index":0,"content_index":0}),
                    ),
                    (
                        "response.content_part.done",
                        json!({"type":"response.content_part.done","item_id":item_id,"output_index":0,"content_index":0,"part":{"type":"output_text","text":output.text,"annotations":[]}}),
                    ),
                    (
                        "response.output_item.done",
                        json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":item_id,"status":"completed","role":"assistant","content":[{"type":"output_text","text":output.text,"annotations":[]}]}}),
                    ),
                ]
            }
            ModelEvent::ToolCallStart {
                index,
                call_id,
                name,
            } => vec![(
                "response.output_item.added",
                json!({"type":"response.output_item.added","output_index":index + usize::from(*text_started),"item":{"type":"function_call","id":format!("fc_{call_id}"),"call_id":call_id,"name":name,"arguments":"","status":"in_progress"}}),
            )],
            ModelEvent::ToolCallArgumentsDelta { index, delta } => {
                let tool = output.tools.get(index);
                let call_id = tool.map(|tool| tool.id.as_str()).unwrap_or_default();
                vec![(
                    "response.function_call_arguments.delta",
                    json!({"type":"response.function_call_arguments.delta","item_id":format!("fc_{call_id}"),"output_index":index + usize::from(*text_started),"delta":delta}),
                )]
            }
            ModelEvent::ToolCallEnd { index } => {
                let tool = output.tools.get(index);
                let arguments = tool.map(|tool| tool.arguments.as_str()).unwrap_or_default();
                let call_id = tool.map(|tool| tool.id.as_str()).unwrap_or_default();
                let item_id = format!("fc_{call_id}");
                vec![
                    (
                        "response.function_call_arguments.done",
                        json!({"type":"response.function_call_arguments.done","item_id":item_id,"output_index":index + usize::from(*text_started),"arguments":arguments}),
                    ),
                    (
                        "response.output_item.done",
                        json!({"type":"response.output_item.done","output_index":index + usize::from(*text_started),"item":{"type":"function_call","id":item_id,"call_id":call_id,"name":tool.map(|tool| tool.name.as_str()).unwrap_or("tool"),"arguments":arguments,"status":"completed"}}),
                    ),
                ]
            }
            ModelEvent::Done(_) => vec![(
                "response.completed",
                json!({"type":"response.completed","response":output.json(protocol,id,model)}),
            )],
            _ => Vec::new(),
        },
        Protocol::Messages => match event {
            ModelEvent::ThinkingStart => match blocks.thinking {
                Some(_) => Vec::new(),
                None => {
                    let index = blocks.open();
                    blocks.thinking = Some(index);
                    vec![(
                        "content_block_start",
                        json!({"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":""}}),
                    )]
                }
            },
            ModelEvent::ThinkingDelta(delta) => {
                let Some(index) = blocks.thinking else {
                    return Vec::new();
                };
                vec![(
                    "content_block_delta",
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":delta}}),
                )]
            }
            ModelEvent::ThinkingEnd => match blocks.thinking.take() {
                Some(index) => vec![(
                    "content_block_stop",
                    json!({"type":"content_block_stop","index":index}),
                )],
                None => Vec::new(),
            },
            ModelEvent::TextStart => open_text_block(blocks),
            ModelEvent::TextDelta(delta) => {
                let mut events = open_text_block(blocks);
                if let Some(index) = blocks.text {
                    events.push(("content_block_delta",json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":delta}})));
                }
                events
            }
            ModelEvent::TextEnd => match blocks.text.take() {
                Some(index) => vec![(
                    "content_block_stop",
                    json!({"type":"content_block_stop","index":index}),
                )],
                None => Vec::new(),
            },
            ModelEvent::ToolCallStart {
                index,
                call_id,
                name,
            } => {
                let block = match blocks.tools.get(index) {
                    Some(block) => *block,
                    None => {
                        let block = blocks.open();
                        blocks.tools.insert(*index, block);
                        block
                    }
                };
                vec![(
                    "content_block_start",
                    json!({"type":"content_block_start","index":block,"content_block":{"type":"tool_use","id":call_id,"name":name,"input":{}}}),
                )]
            }
            ModelEvent::ToolCallArgumentsDelta { index, delta } => {
                let Some(block) = blocks.tools.get(index).copied() else {
                    return Vec::new();
                };
                vec![(
                    "content_block_delta",
                    json!({"type":"content_block_delta","index":block,"delta":{"type":"input_json_delta","partial_json":delta}}),
                )]
            }
            ModelEvent::ToolCallEnd { index } => {
                let Some(block) = blocks.tools.remove(index) else {
                    return Vec::new();
                };
                vec![(
                    "content_block_stop",
                    json!({"type":"content_block_stop","index":block}),
                )]
            }
            ModelEvent::Done(reason) => {
                let stop = match reason {
                    FinishReason::Stop => "end_turn",
                    FinishReason::Length => "max_tokens",
                    FinishReason::ToolUse => "tool_use",
                };
                let mut events: Vec<(&'static str, Value)> = Vec::new();
                // A provider may finish without closing its blocks; the
                // protocol requires every started block to stop first.
                if let Some(index) = blocks.thinking.take() {
                    events.push(("content_block_stop", json!({"type":"content_block_stop","index":index})));
                }
                if let Some(index) = blocks.text.take() {
                    events.push(("content_block_stop", json!({"type":"content_block_stop","index":index})));
                }
                events.push((
                    "message_delta",
                    json!({"type":"message_delta","delta":{"stop_reason":stop,"stop_sequence":null},"usage":output.usage_json(protocol)}),
                ));
                events.push(("message_stop", json!({"type":"message_stop"})));
                events
            }
            _ => Vec::new(),
        },
    }
}

/// Opens the text block on its first delta, reusing one index for the whole
/// text run so later deltas keep targeting an open block.
fn open_text_block(blocks: &mut BlockIndexes) -> Vec<(&'static str, Value)> {
    if blocks.text.is_some() {
        return Vec::new();
    }
    let index = blocks.open();
    blocks.text = Some(index);
    vec![(
        "content_block_start",
        json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}),
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(events: &[ModelEvent]) -> Vec<(String, Value)> {
        let mut output = Output::default();
        let mut blocks = BlockIndexes::default();
        let mut text_started = false;
        let mut emitted = Vec::new();
        for event in events {
            output.update(event);
            for (name, value) in stream_events(
                Protocol::Messages,
                event,
                "id",
                "model",
                &output,
                &mut text_started,
                &mut blocks,
            ) {
                emitted.push((name.to_string(), value));
            }
        }
        emitted
    }

    fn indexes(events: &[(String, Value)], kind: &str) -> Vec<u64> {
        events
            .iter()
            .filter(|(_, value)| value["type"] == kind)
            .map(|(_, value)| value["index"].as_u64().expect("index"))
            .collect()
    }

    #[test]
    fn thinking_text_and_tool_get_distinct_increasing_blocks() {
        let events = drive(&[
            ModelEvent::ThinkingStart,
            ModelEvent::ThinkingDelta("hmm".into()),
            ModelEvent::ThinkingEnd,
            ModelEvent::TextStart,
            ModelEvent::TextDelta("hello".into()),
            ModelEvent::TextEnd,
            ModelEvent::ToolCallStart {
                index: 0,
                call_id: "call-1".into(),
                name: "Read".into(),
            },
            ModelEvent::ToolCallArgumentsDelta {
                index: 0,
                delta: "{}".into(),
            },
            ModelEvent::ToolCallEnd { index: 0 },
            ModelEvent::Done(FinishReason::ToolUse),
        ]);

        assert_eq!(indexes(&events, "content_block_start"), vec![0, 1, 2]);
        assert_eq!(indexes(&events, "content_block_delta"), vec![0, 1, 2]);
        assert_eq!(indexes(&events, "content_block_stop"), vec![0, 1, 2]);

        let kinds: Vec<&str> = events
            .iter()
            .filter(|(name, _)| name == "content_block_start")
            .map(|(_, value)| value["content_block"]["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["thinking", "text", "tool_use"]);
    }

    #[test]
    fn text_block_opens_once_and_closes_once_without_thinking() {
        let events = drive(&[
            ModelEvent::TextDelta(" a".into()),
            ModelEvent::TextDelta(" b".into()),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);

        assert_eq!(indexes(&events, "content_block_start"), vec![0]);
        assert_eq!(indexes(&events, "content_block_delta"), vec![0, 0]);
        assert_eq!(indexes(&events, "content_block_stop"), vec![0]);
        let stop_reason = events
            .iter()
            .find(|(name, _)| name == "message_delta")
            .map(|(_, value)| value["delta"]["stop_reason"].clone())
            .unwrap();
        assert_eq!(stop_reason, "end_turn");
    }

    #[test]
    fn done_closes_blocks_left_open_by_the_provider() {
        let events = drive(&[
            ModelEvent::ThinkingStart,
            ModelEvent::ThinkingDelta("hmm".into()),
            ModelEvent::TextDelta("partial".into()),
            ModelEvent::Done(FinishReason::Length),
        ]);

        assert_eq!(indexes(&events, "content_block_stop"), vec![0, 1]);
        let last = events.last().expect("message_stop");
        assert_eq!(last.0, "message_stop");
    }

    #[test]
    fn tool_deltas_do_not_emit_for_unknown_indexes() {
        let events = drive(&[
            ModelEvent::ToolCallArgumentsDelta {
                index: 7,
                delta: "{}".into(),
            },
            ModelEvent::ToolCallEnd { index: 7 },
        ]);

        assert!(events.is_empty());
    }
}
