// spec/examples/buildV01Reply.mjs
//
// Reference implementation of `buildV01Reply()` for new agents joining
// an OpenClaw instance that has the peer-contract v0.1 plugin installed.
//
// Usage:
//   import { buildV01Reply } from "./buildV01Reply.mjs";
//   const envelope = buildV01Reply(incomingDispatch, mySessionKey, {
//     actualWork: "我完成了...",
//     senderAgentId: "new-agent",
//   });
//   await sessions_send({ sessionKey: incomingDispatch.source_session_key, message: envelope });
//
// This file is a reference, not a runtime binding. New agents copy the
// shape and fill in their own `actualWork` / `senderAgentId`. The 5
// fields most often mis-filled (and the fixes) are documented in
// `docs/common-blocks-and-fix.md`.

export function buildV01Reply(incoming, currentSessionKey, options = {}) {
  if (!incoming || typeof incoming !== "object") {
    throw new Error("buildV01Reply: incoming must be a parsed JSON object");
  }
  if (!incoming.dispatch_id || !incoming.source_session_key) {
    throw new Error("buildV01Reply: incoming missing dispatch_id or source_session_key");
  }

  const reply = {
    schema_version: "v2",
    protocol_version: "0.1.0",
    dispatch_id: crypto.randomUUID(),
    parent_dispatch_id: null,                                  // reply is a top-level dispatch, parent=null
    original_dispatch_id: incoming.dispatch_id,                  // link back to incoming
    retry_count: 0,
    correlation_id: incoming.correlation_id ?? crypto.randomUUID(),  // pass-through or new
    card_id: incoming.card_id,                                  // pass-through
    parent_card_id: null,
    goal: `Reply: ${incoming.goal}`,

    // ★ sender_session_key: must = currentSessionKey (the replying agent itself),
    //   NOT incoming.target_session_key (this is 踩坑 #3 — see common-blocks-and-fix.md)
    sender_session_key: currentSessionKey,
    sender_role: options.senderRole ?? "work",                  // new agent's own role (work / bus, NOT main)

    // ★ target_session_key: incoming.source_session_key (reply to where it came from)
    target_session_key: incoming.source_session_key,
    target_role: incoming.sender_role ?? "bus",                 // usually bus for replies to dispatcher

    context_payload: {
      task_spec: options.actualWork ?? "delivered",
      extracted_history: options.extractedHistory ?? "",
      acceptance_criteria: options.acceptanceCriteria ?? "delivered",
    },
    payload_completeness: "self_contained",
    priority: incoming.priority ?? "normal",
    max_runtime_minutes: 5,
    acceptance_policy: {
      ac_owner: incoming.source_session_key,                   // ★ pass-through
      ac_immutable_by_worker: true,
      verifier: incoming.source_session_key,
      retry_on_fail: false,
      max_retry_count: 0,
    },
    expected_reply_format: "text",

    // ★ reply_to at TOP level (Drift 2 enforced, plugin v0.1 requires this at top-level — 踩坑 #1)
    reply_to: incoming.source_session_key,

    // ★ source at TOP level (Drift 1 + Drift 5 enforced, sender agentId — 踩坑 #2)
    source: options.senderAgentId,                              // e.g. "new-agent" — must be in agent-registry whitelist

    in_reply_to: incoming.dispatch_id,                          // optional, conversation link
  };
  return JSON.stringify(reply);
}
