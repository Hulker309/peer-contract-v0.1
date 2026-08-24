// peer-contract-enforcer dispatch schema validator
// Day 2: full v0.1 schema + HR6 session-existence (single-entry validator for tool-guard)
// Day 4: HR4 payload-self-contained integration (calls validatePayloadSelfContained from dispatch-validator.js)
//
// Companion to dispatch-validator.js (Day 4: HR4 payload-self-contained).
// This file owns the FULL v0.1 §2.2 schema (20+ required fields, including
// protocol_version, dispatch_id, parent_dispatch_id, original_dispatch_id,
// retry_count, correlation_id, card_id, parent_card_id, goal, sender_role,
// sender_session_key, target_role, target_session_key, context_payload.*,
// payload_completeness, priority, max_runtime_minutes, acceptance_policy.*,
// expected_reply_format), HR1 (no-default-to-main), and HR6 session existence
// (target_session_key must resolve via session registry).
//
// payload shape (sessions_send params): top-level v2 | params.message object |
// params.message JSON string | legacy { sessionKey, message }.

import { validatePayloadSelfContained } from "./dispatch-validator.js";

// v0.1 protocol §2.2 top-level required fields.
const V2_REQUIRED_TOP_FIELDS = [
  "schema_version",
  "protocol_version",
  "dispatch_id",
  "parent_dispatch_id",
  "original_dispatch_id",
  "retry_count",
  "correlation_id",
  "card_id",
  "parent_card_id",
  "goal",
  "sender_role",
  "sender_session_key",
  "target_role",
  "target_session_key",
  "context_payload",
  "payload_completeness",
  "priority",
  "max_runtime_minutes",
  "acceptance_policy",
  "expected_reply_format",
];

const V2_REQUIRED_CONTEXT_PAYLOAD_FIELDS = [
  "task_spec",
  "extracted_history",
  "acceptance_criteria",
];

const V2_REQUIRED_ACCEPTANCE_POLICY_FIELDS = [
  "ac_owner",
  "ac_immutable_by_worker",
  "verifier",
  "retry_on_fail",
  "max_retry_count",
];

const V2_VALID_PRIORITIES = ["urgent", "high", "normal", "low"];
const V2_VALID_PAYLOAD_COMPLETENESS = ["self_contained", "need_lookup"];
// Day 6a followup (Mavis 2026-08-22 09:34): align with spec/01-dispatch.schema.json
// (enum: main/bus/work). Plugin was stricter than spec, forcing Kelsen.bus (role=main)
// to lie about sender_role. Adding "main" here lets main-session dispatches pass
// schema check; HR1 (intent-aware) still semantically blocks main-targeted dispatches
// unless intent is in mainIntentsAllowlist.
const V2_VALID_SENDER_ROLES = ["main", "bus", "work"];
const V2_VALID_TARGET_ROLES = ["main", "bus", "work"];
// Day 6a followup (Mavis 2026-08-22 09:34): default intent allowlist for HR1.
// "task_assignment" is the conservative default (no-default-to-main) but
// "inform" / "query" / "sub-task" / "response" / "ack" / "ping" are explicit
// intents that are allowed to target a main session.
const V2_DEFAULT_MAIN_INTENTS_ALLOWLIST = ["inform", "query", "sub-task", "response", "ack", "ping"];

/**
 * @typedef {Object} ValidationError
 * @property {"HR1"|"HR6"|"HR8"} hr
 * @property {string} field
 * @property {string} message
 * @property {string} reason
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {ValidationError[]} errors
 * @property {string[]} warnings
 * @property {Object} [payload]
 * @property {string} [resolvedShape]
 * @property {string} [targetSessionKey]
 * @property {string} [senderSessionKey]
 * @property {number} payloadSizeBytes
 */

/**
 * Try to parse params.message as a JSON object string.
 */
function tryParseMessageObject(message) {
  if (!message) return undefined;
  if (typeof message === "object" && !Array.isArray(message)) return message;
  if (typeof message === "string") {
    const trimmed = message.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON
    }
  }
  return undefined;
}

/**
 * Extract dispatch payload from sessions_send params (4 shapes).
 * @param {Record<string, unknown>} params
 * @returns {{ payload: Object | undefined, shape: string, targetSessionKey?: string }}
 */
export function extractDispatchPayload(params) {
  if (!params || typeof params !== "object") {
    return { payload: undefined, shape: "invalid" };
  }

  if (params.schema_version === "v2") {
    return { payload: params, shape: "v2_top_level", targetSessionKey: /** @type {string} */ (params.target_session_key) };
  }

  const messageObj = tryParseMessageObject(params.message);
  if (messageObj && messageObj.schema_version === "v2") {
    const shape = typeof params.message === "object" ? "v2_message_object" : "v2_message_string";
    return { payload: messageObj, shape, targetSessionKey: /** @type {string} */ (messageObj.target_session_key) };
  }

  // Legacy v1.1: { sessionKey, message } — wrap as pseudo-payload
  const legacyTarget = /** @type {string} */ (params.sessionKey ?? params.targetSessionKey);
  if (legacyTarget) {
    return {
      payload: { schema_version: "v1.1", target_session_key: legacyTarget },
      shape: "legacy",
      targetSessionKey: legacyTarget,
    };
  }

  return { payload: undefined, shape: "unknown" };
}

/**
 * Validate v2 payload against full v0.1 §2.2 schema.
 * @param {Object} payload
 * @returns {ValidationError[]}
 */
export function validateV2Schema(payload) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return [{ hr: "HR6", field: "(root)", message: "missing dispatch payload", reason: "missing_payload" }];
  }

  for (const field of V2_REQUIRED_TOP_FIELDS) {
    if (!(field in payload)) {
      errors.push({ hr: "HR6", field, message: `missing required field '${field}'`, reason: `missing_${field}` });
    }
  }

  if ("priority" in payload && !V2_VALID_PRIORITIES.includes(payload.priority)) {
    errors.push({ hr: "HR6", field: "priority", message: `invalid priority '${payload.priority}'`, reason: "invalid_priority" });
  }
  if ("payload_completeness" in payload && !V2_VALID_PAYLOAD_COMPLETENESS.includes(payload.payload_completeness)) {
    errors.push({ hr: "HR6", field: "payload_completeness", message: `invalid payload_completeness '${payload.payload_completeness}'`, reason: "invalid_payload_completeness" });
  }
  if ("sender_role" in payload && !V2_VALID_SENDER_ROLES.includes(payload.sender_role)) {
    errors.push({ hr: "HR6", field: "sender_role", message: `invalid sender_role '${payload.sender_role}'`, reason: "invalid_sender_role" });
  }
  if ("target_role" in payload && !V2_VALID_TARGET_ROLES.includes(payload.target_role)) {
    errors.push({ hr: "HR6", field: "target_role", message: `invalid target_role '${payload.target_role}'`, reason: "invalid_target_role" });
  }

  if (payload.context_payload && typeof payload.context_payload === "object") {
    for (const field of V2_REQUIRED_CONTEXT_PAYLOAD_FIELDS) {
      if (!(field in payload.context_payload)) {
        errors.push({ hr: "HR6", field: `context_payload.${field}`, message: `missing context_payload.${field}`, reason: `missing_context_payload_${field}` });
      }
    }
    
    // HR4: payload-self-contained (references + need_lookup rules)
    // payload_completeness is top-level (v0.1 §2.2), references is inside context_payload
    const hr4Check = validatePayloadSelfContained({
      ...payload.context_payload,
      payload_completeness: payload.payload_completeness,
    });
    if (!hr4Check.ok) {
      errors.push({ hr: "HR4", field: "context_payload", message: hr4Check.reason, reason: "payload_not_self_contained" });
    }
  }

  if (payload.acceptance_policy && typeof payload.acceptance_policy === "object") {
    for (const field of V2_REQUIRED_ACCEPTANCE_POLICY_FIELDS) {
      if (!(field in payload.acceptance_policy)) {
        errors.push({ hr: "HR6", field: `acceptance_policy.${field}`, message: `missing acceptance_policy.${field}`, reason: `missing_acceptance_policy_${field}` });
      }
    }
  }

  return errors;
}

/**
 * HR1: no-default-to-main (universal). target cannot be main unless intent is in
 * mainIntentsAllowlist. main-to-main is also rejected unless intent is in the allowlist.
 *
 * Day 6a followup (Mavis 2026-08-22 09:34): Kelsen report 8/22 9:06 Issue 1 — strict
 * 3-段 main pattern was over-enforcing, blocking legitimate bus↔bus cross-agent dispatch.
 * Fix: intent-aware HR1. Kelsen report 9/22 user architectural critique: cross-agent
 * dispatch to work session is anti-pattern (bypasses target agent's coordination layer).
 * Fix: cross-agent-to-work block. Both fixes live here.
 *
 * @param {string} [targetSessionKey]
 * @param {string} [senderSessionKey]
 * @param {object} [opts]
 * @param {string} [opts.intent] — payload.intent; default "task_assignment" (conservative)
 * @param {string[]} [opts.mainIntentsAllowlist] — intents that may target a main session
 * @param {boolean} [opts.crossAgentToWorkBlocked] — if true, block cross-agent to work
 * @param {RegExp} [opts.workSessionKeyPattern] — pattern to detect work target
 * @returns {ValidationError[]}
 */
export function validateNoDefaultToMain(targetSessionKey, senderSessionKey, opts = {}) {
  /** @type {ValidationError[]} */
  const errors = [];
  const intent = opts.intent ?? "task_assignment";
  const mainIntentsAllowlist = opts.mainIntentsAllowlist ?? V2_DEFAULT_MAIN_INTENTS_ALLOWLIST;
  const crossAgentToWorkBlocked = opts.crossAgentToWorkBlocked !== false; // default true
  const workPattern = opts.workSessionKeyPattern;

  // Extract agentIds from sessionKeys (format: agent:<id>:<role>:<ctx>...)
  const targetAgentId = typeof targetSessionKey === "string" ? targetSessionKey.match(/^(agent:[^:]+):/)?.[1] : undefined;
  const senderAgentId = typeof senderSessionKey === "string" ? senderSessionKey.match(/^(agent:[^:]+):/)?.[1] : undefined;

  // New rule: cross-agent dispatch to work session is forbidden (Mavis 2026-08-22 09:34,
  // per user architectural critique). Same-agent work target is allowed (intra-agent
  // sub-session spawn, HR9 workbench policy can still gate the tool itself).
  if (crossAgentToWorkBlocked && targetSessionKey && workPattern && workPattern.test(targetSessionKey)) {
    if (senderAgentId && targetAgentId && senderAgentId !== targetAgentId) {
      errors.push({
        hr: "HR1",
        field: "target_session_key",
        message: `cross-agent dispatch to work session '${targetSessionKey}' is forbidden (sender='${senderAgentId}'); dispatch to target's main or bus instead`,
        reason: "cross_agent_to_work_forbidden",
      });
    }
  }

  if (!targetSessionKey) {
    errors.push({ hr: "HR1", field: "target_session_key", message: "missing target_session_key (no-default-to-main: cannot infer target)", reason: "missing_target_session_key" });
  } else if (/^agent:[^:]+:main$/.test(targetSessionKey) && !mainIntentsAllowlist.includes(intent)) {
    errors.push({ hr: "HR1", field: "target_session_key", message: `target_session_key '${targetSessionKey}' is a main session with intent='${intent}' (no-default-to-main forbids; allowlist: ${mainIntentsAllowlist.join(",")})`, reason: "main_session_forbidden" });
  }
  if (senderSessionKey && /^agent:[^:]+:main$/.test(senderSessionKey)
      && targetSessionKey && /^agent:[^:]+:main$/.test(targetSessionKey)
      && !mainIntentsAllowlist.includes(intent)) {
    errors.push({ hr: "HR1", field: "sender_session_key", message: `main → main dispatch with intent='${intent}' is meaningless (allowlist: ${mainIntentsAllowlist.join(",")})`, reason: "main_to_main_dispatch" });
  }
  return errors;
}

/**
 * HR6 session-existence: target_session_key must resolve via session registry.
 * Sender is trusted (comes from ctx.runtime); if payload also declares sender_session_key,
 * cross-check it equals ctx.sessionKey (validateSenderConsistency).
 *
 * @param {string} [targetSessionKey]
 * @param {{ validateSessionKey: (key: string) => { valid: boolean, reason: string } }} sessionRegistry
 * @returns {ValidationError[]}
 */
export function validateSessionExistence(targetSessionKey, sessionRegistry) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (targetSessionKey) {
    const v = sessionRegistry.validateSessionKey(targetSessionKey);
    if (!v.valid) {
      errors.push({ hr: "HR6", field: "target_session_key", message: `target session '${targetSessionKey}' not found: ${v.reason}`, reason: "target_session_not_found" });
    }
  }
  return errors;
}

/**
 * Day 8 followup v2 (Mavis 2026-08-24, 老板 10:33 followup + 10:50 提示"结合 workboard"):
 * HR10 task-dependency.
 *
 * Architectural decision: peer-contract-enforcer does NOT maintain its own
 * task state — that's the workboard plugin's job. The v0.1 protocol layer is
 * for message-shape enforcement, not workflow-state tracking. Workboard has:
 *   - WorkboardCard.taskId / parentTaskId fields
 *   - WORKBOARD_LINK_TYPES: ["parent", "child", "blocks", "blocked_by", "relates_to"]
 *   - linkCards(parentId, childId) for explicit dependency edges
 *   - dependencyTargetStatus + promoteReady private methods that enforce
 *     "child card only ready after parent is in target status" at dispatch time
 *   - `done` status = task completed
 *
 * So HR10 here is a **schema-only** check: parent_task_id MUST be a valid
 * UUID (matching workboard card id format). The actual dependency-graph
 * enforcement (waiting for parent in "done" status before child can be
 * dispatched) is the workboard dispatch engine's responsibility, not ours.
 *
 * This keeps the plugin lean and avoids duplicating state that workboard
 * already tracks authoritatively. Callers wire up the dependency edge via
 * `workboard linkCards(parentId, childId)` after creating the child card.
 *
 * @param {string} [parentTaskId]
 * @returns {ValidationError[]}
 */
export function validateTaskDependency(parentTaskId) {
  // Only `undefined` means "no dependency declared" — no error.
  // null, empty string, or other non-string values are user mistakes and BLOCK.
  if (parentTaskId === undefined) return [];
  /** @type {ValidationError[]} */
  const errors = [];
  if (typeof parentTaskId !== "string") {
    errors.push({
      hr: "HR10",
      field: "parent_task_id",
      message: `parent_task_id must be a string (workboard card id), got ${parentTaskId === null ? "null" : typeof parentTaskId}`,
      reason: "parent_task_id_invalid_type",
    });
    return errors;
  }
  if (parentTaskId.length === 0) {
    errors.push({
      hr: "HR10",
      field: "parent_task_id",
      message: `parent_task_id is an empty string; omit the field entirely if there's no dependency, or pass a valid workboard card id (UUID)`,
      reason: "parent_task_id_empty",
    });
    return errors;
  }
  // UUID v1-v5 (8-4-4-4-12 hex). Workboard card ids are UUIDs.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentTaskId)) {
    errors.push({
      hr: "HR10",
      field: "parent_task_id",
      message: `parent_task_id '${parentTaskId}' is not a valid UUID; per Day 8 v2 design parent_task_id is a workboard card id (workboard enforces the actual dependency graph via linkCards + promoteReady). Use a workboard card id, e.g. '7f4a2c10-...'.`,
      reason: "parent_task_id_not_uuid",
    });
  }
  return errors;
}

/**
 * Day 8 followup (Mavis 2026-08-24, 老板 10:33 followup): HR5.1 multi-target.
 *
 * When `target_session_keys` is an array (broadcast multi-target fan-out),
 * each entry must satisfy the same bus-context-required rule as a single
 * target_session_key (Day 8 HR5.1: bare `agent:<id>:bus` is BLOCKED).
 *
 * Why a separate validator rather than reusing validateBusContextRequired
 * on each element: the field name is different (target_session_keys[i] vs
 * target_session_key), and the error message naming differs to make multi-
 * target validation failures easier to diagnose.
 *
 * @param {string[]} [targetSessionKeys]
 * @param {{ busContextRequired?: boolean }} [opts]
 * @returns {ValidationError[]}
 */
export function validateMultiTargetBusContext(targetSessionKeys, opts = {}) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (opts.busContextRequired === false) return [];
  if (!Array.isArray(targetSessionKeys) || targetSessionKeys.length === 0) return [];

  for (let i = 0; i < targetSessionKeys.length; i++) {
    const k = targetSessionKeys[i];
    if (typeof k !== "string") {
      errors.push({
        hr: "HR5",
        field: `target_session_keys[${i}]`,
        message: `target_session_keys[${i}] must be a string session key, got ${typeof k}`,
        reason: "multi_target_session_keys_invalid",
      });
      continue;
    }
    const m = k.match(/^agent:[^:]+:bus(?::(.*))?$/);
    if (!m) continue; // not a bus-shaped key, leave to other validators
    const contextId = m[1];
    if (!contextId || contextId.length === 0) {
      errors.push({
        hr: "HR5",
        field: `target_session_keys[${i}]`,
        message: `target_session_keys[${i}] = '${k}' is missing a context-id segment; per v0.1 spec (docs/bus-coordination.md) bus must be per-context (e.g. agent:<id>:bus:dashboard, agent:<id>:bus:webchat:<user-id>). Bare 'agent:<id>:bus' collapses to a shared inbox.`,
        reason: "bus_context_required_multi",
      });
    }
  }
  return errors;
}

/**
 * Day 8 followup (Mavis 2026-08-24, 老板 8/10 反馈): HR5.1 bus-context-required.
 *
 * When `busContextRequired: true` (default), any `target_session_key` that
 * *looks like* a bus session key (matches `^agent:[^:]+:bus(?::(.*))?$`) MUST
 * include a non-empty context-id segment. Bare `agent:<id>:bus` (no context)
 * collapses to a single shared inbox and reintroduces the main-session-style
 * cross-task contamination that bus was designed to avoid. See
 * docs/bus-coordination.md "Bus session types":
 *   agent:<agent-id>:bus:<context-id>
 * Examples: agent:peer-trial:bus:dashboard, agent:peer-trial:bus:webchat:user-123,
 *           agent:kelsen:bus:dispatch.
 *
 * The check is driven by the **session key shape**, not by `target_role`. This
 * matters because v1.1 / legacy / CLI-via-agent dispatches may not populate
 * `target_role` at all — relying on `target_role === "bus"` would silently
 * miss those dispatches. The key shape is the authoritative source of truth.
 *
 * Sender-side bus keys (sender_session_key) are NOT enforced here: the sender
 * bus is a known bus (e.g. main's own bus for status reports). This rule
 * applies to the *target* bus, where the coordination must scope to a
 * specific context.
 *
 * Operators may set `busContextRequired: false` to opt out (e.g. for a single
 * inbox that genuinely needs to aggregate all peers). The opt-out is
 * explicit, not silent.
 *
 * @param {string} [targetSessionKey]
 * @param {string} [targetRole]  // retained for symmetry / future per-role rules; not used
 * @param {{ busContextRequired?: boolean, busSessionKeyPattern?: RegExp }} [opts]
 * @returns {ValidationError[]}
 */
export function validateBusContextRequired(targetSessionKey, targetRole, opts = {}) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (opts.busContextRequired === false) return errors; // explicit opt-out
  if (!targetSessionKey) return errors;

  // Parse the key shape: agent:<id>:bus:<rest...>
  // Reject if the segment after "bus" is empty (i.e. exactly `agent:<id>:bus`).
  const m = targetSessionKey.match(/^agent:[^:]+:bus(?::(.*))?$/);
  if (!m) return errors; // not a bus key, leave to other validators
  const contextId = m[1];
  if (!contextId || contextId.length === 0) {
    errors.push({
      hr: "HR5",
      field: "target_session_key",
      message: `bus session key '${targetSessionKey}' is missing a context-id segment; per v0.1 spec (docs/bus-coordination.md) bus must be per-context (e.g. agent:<id>:bus:dashboard, agent:<id>:bus:webchat:<user-id>). Bare 'agent:<id>:bus' collapses to a shared inbox.`,
      reason: "bus_context_required",
    });
  }
  return errors;
}

/**
 * Cross-check payload.sender_session_key against ctx.sessionKey (when both present).
 * @param {string | undefined} payloadSender
 * @param {string | undefined} ctxSender
 * @returns {ValidationError[]}
 */
export function validateSenderConsistency(payloadSender, ctxSender) {
  if (!payloadSender || !ctxSender) return [];
  if (payloadSender === ctxSender) return [];
  return [{ hr: "HR6", field: "sender_session_key", message: `payload.sender_session_key ('${payloadSender}') does not match ctx.sessionKey ('${ctxSender}')`, reason: "sender_session_key_mismatch" }];
}

/**
 * HR8: payload-size-cap.
 * @param {Record<string, unknown>} params
 * @param {number} capBytes
 * @returns {{ sizeBytes: number, error: ValidationError | undefined }}
 */
export function validatePayloadSize(params, capBytes) {
  const sizeBytes = JSON.stringify(params).length;
  if (sizeBytes > capBytes) {
    return { sizeBytes, error: { hr: "HR8", field: "(payload)", message: `payload size ${sizeBytes}B exceeds cap ${capBytes}B`, reason: "payload_size_exceeded" } };
  }
  return { sizeBytes, error: undefined };
}

/**
 * Single-entry validator for sessions_send (HR1 + HR6 + HR8 in one pipeline).
 * @param {Record<string, unknown>} params — event.params
 * @param {{ sessionKey?: string }} [ctx]
 * @param {{ sessionRegistry: { validateSessionKey: (key: string) => { valid: boolean, reason: string } }, payloadSizeCapBytes: number, mainIntentsAllowlist?: string[], crossAgentToWorkBlocked?: boolean, workSessionKeyPattern?: RegExp }} deps
 * @returns {ValidationResult}
 */
export function validateDispatchSchema(params, ctx, deps) {
  /** @type {ValidationError[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  // Step 1: HR8 size cap (fail-fast)
  const sizeCheck = validatePayloadSize(params, deps.payloadSizeCapBytes);
  if (sizeCheck.error) errors.push(sizeCheck.error);

  // Step 2: Extract dispatch payload (4 shapes)
  const extracted = extractDispatchPayload(params);
  const payload = extracted.payload;

  // Step 2.5: Day 6a followup (Mavis 2026-08-22 09:53, user #8): auto-fill correlation_id
  // chain fields. This is a *convenience* for the common case — Kelsen can still set
  // these explicitly to override.
  //   - New task root (parent_dispatch_id=null): correlation_id = dispatch_id (self-rooted)
  //   - Sub-task (parent_dispatch_id set, original_dispatch_id null):
  //     original_dispatch_id = parent_dispatch_id (inherit from parent's chain root)
  if (payload && typeof payload === "object") {
    if (payload.correlation_id == null && payload.parent_dispatch_id == null && payload.dispatch_id) {
      payload.correlation_id = payload.dispatch_id;
    }
    if (payload.original_dispatch_id == null && payload.parent_dispatch_id) {
      payload.original_dispatch_id = payload.parent_dispatch_id;
    }
  }

  // Step 3: Resolve sender_session_key — payload > ctx
  const ctxSender = ctx?.sessionKey;
  const senderSessionKey = /** @type {string | undefined} */ (payload?.sender_session_key ?? ctxSender);

  // Step 4: Resolve target_session_key
  const targetSessionKey = extracted.targetSessionKey ?? payload?.target_session_key;

  // Step 5: HR1 (Day 6a followup: intent-aware + cross-agent-to-work block)
  const intent = typeof payload?.intent === "string" ? payload.intent : undefined;
  for (const e of validateNoDefaultToMain(targetSessionKey, senderSessionKey, {
    intent,
    mainIntentsAllowlist: deps.mainIntentsAllowlist,
    crossAgentToWorkBlocked: deps.crossAgentToWorkBlocked,
    workSessionKeyPattern: deps.workSessionKeyPattern,
  })) errors.push(e);

  // Step 5.1: Day 8 followup (Mavis 2026-08-24, 老板 8/10 反馈): HR5.1 bus-context-required.
  // Bus targets must include a context-id segment. Default ON; opt-out via busContextRequired=false.
  const targetRole = typeof payload?.target_role === "string" ? payload.target_role : undefined;
  for (const e of validateBusContextRequired(targetSessionKey, targetRole, {
    busContextRequired: deps.busContextRequired,
    busSessionKeyPattern: deps.busSessionKeyPattern,
  })) errors.push(e);

  // Step 5.2: Day 8 followup v2 (Mavis 2026-08-24, 老板 10:50 提示"结合 workboard"):
  // HR10 task-dependency (schema-only — workboard is source-of-truth for state).
  // parent_task_id can appear at routing level or inside bus.task_assignment.
  const parentTaskId = typeof payload?.parent_task_id === "string"
    ? payload.parent_task_id
    : (typeof payload?.bus?.task_assignment?.parent_task_id === "string"
       ? payload.bus.task_assignment.parent_task_id
       : undefined);
  for (const e of validateTaskDependency(parentTaskId)) errors.push(e);

  // Step 5.3: Day 8 followup (Mavis 2026-08-24, 老板 10:33 followup): HR5.1 multi-target.
  // target_session_keys is an array (broadcast multi-target). Each bus key
  // must satisfy bus-context-required. Mutually exclusive with target_session_key
  // (the spec layer enforces mutual exclusion; here we just validate each entry).
  const targetSessionKeys = Array.isArray(payload?.target_session_keys)
    ? payload.target_session_keys
    : undefined;
  for (const e of validateMultiTargetBusContext(targetSessionKeys, {
    busContextRequired: deps.busContextRequired,
  })) errors.push(e);

  // Step 6: HR6 schema (only if v2 payload detected)
  if (extracted.shape === "v2_top_level" || extracted.shape === "v2_message_object" || extracted.shape === "v2_message_string") {
    for (const e of validateV2Schema(payload)) errors.push(e);
  } else if (extracted.shape === "legacy") {
    warnings.push(`legacy v1.1 dispatch detected (no v2 schema fields); only basic HR1 + HR6 session-existence enforced`);
  } else {
    errors.push({ hr: "HR6", field: "(root)", message: "could not resolve dispatch payload", reason: "unresolvable_payload" });
  }

  // Step 7: HR6 session-existence (target only — sender comes from ctx, trusted)
  for (const e of validateSessionExistence(targetSessionKey, deps.sessionRegistry)) errors.push(e);

  // (Note: v0.1 protocol allows sender_session_key to be the upstream dispatcher
  // bus, which may differ from ctx.sessionKey when ctx is the downstream dispatch
  // session. We don't enforce payload.sender_session_key === ctx.sessionKey;
  // ctx.sessionKey is the authoritative sender from runtime.)

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    payload,
    resolvedShape: extracted.shape,
    targetSessionKey,
    senderSessionKey,
    payloadSizeBytes: sizeCheck.sizeBytes,
  };
}

/**
 * Format ValidationErrors into a single blockReason string.
 * Includes both field path and reason code for testability.
 * @param {ValidationError[]} errors
 * @returns {string}
 */
export function formatBlockReason(errors) {
  if (errors.length === 0) return "";
  const byHr = new Map();
  for (const e of errors) {
    if (!byHr.has(e.hr)) byHr.set(e.hr, []);
    byHr.get(e.hr).push(e);
  }
  const parts = [];
  for (const [hr, errs] of byHr) {
    parts.push(`${hr}: ${errs.map(e => `${e.field}: ${e.message} [${e.reason}]`).join("; ")}`);
  }
  return parts.join(" | ");
}