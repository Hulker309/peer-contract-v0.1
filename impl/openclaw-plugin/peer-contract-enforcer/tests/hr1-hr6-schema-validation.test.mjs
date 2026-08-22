// HR1 (full no-default-to-main) + HR6 (reject-missing-routing) + HR8 (payload-size-cap) unit tests (Day 2)
// Pure ESM .mjs, no TypeScript
// Run with: node tests/hr1-hr6-schema-validation.test.mjs

import { createWorkbenchPolicy, createSessionRoleRegistry } from "../src/workbench-policy.js";
import { createSessionRegistry } from "../src/session-registry.js";
import { createToolGuard } from "../src/tool-guard.js";
import {
  extractDispatchPayload,
  validateDispatchSchema as validateDispatch,
  validateV2Schema,
  validateNoDefaultToMain,
  validateSessionExistence,
  validatePayloadSize,
  formatBlockReason,
} from "../src/dispatch-schema.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
    failed++;
  }
}

function assertEq(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(`${msg} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

function assertOk(result, label = "result") {
  if (result && result.block === true) {
    throw new Error(`${label}: expected allow but got block: ${result.blockReason}`);
  }
}

function assertBlock(result, pattern, label = "result") {
  if (!result || result.block !== true) {
    throw new Error(`${label}: expected block but got allow: ${JSON.stringify(result)}`);
  }
  if (pattern && !pattern.test(result.blockReason)) {
    throw new Error(`${label}: block reason mismatch: "${result.blockReason}" does not match ${pattern}`);
  }
}

function assertValidationOk(v) {
  if (!v.ok) throw new Error(`expected validation pass but got errors: ${JSON.stringify(v.errors)}`);
}
function assertValidationFail(v, pattern) {
  if (v.ok) throw new Error(`expected validation fail but got pass`);
  if (pattern && !v.errors.some(e => pattern.test(e.reason) || pattern.test(e.message))) {
    throw new Error(`validation errors do not match ${pattern}: ${JSON.stringify(v.errors)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const policy = createWorkbenchPolicy({});
const roleRegistry = createSessionRoleRegistry();
const sessionRegistry = createSessionRegistry({ openclawHomeDir: "C:/Users/Administrator/.openclaw" });

// Pre-register a few known bus/work sessions for HR6 tests
const KNOWN_BUS_KEY = "agent:coder:bus:dispatch-test-001";
const KNOWN_WORK_KEY = "agent:coder:work:card-abc:primary:00000000-0000-0000-0000-000000000001";
sessionRegistry.set(KNOWN_BUS_KEY, { agentId: "coder", source: "session_start" });
sessionRegistry.set(KNOWN_WORK_KEY, { agentId: "coder", sessionId: "00000000-0000-0000-0000-000000000001", source: "subagent_spawned" });

const guard = createToolGuard(policy, roleRegistry, sessionRegistry);

const workCtx = { agentId: "coder", sessionKey: KNOWN_WORK_KEY };
const busCtx = { agentId: "coder", sessionKey: KNOWN_BUS_KEY };
const mainCtx = { agentId: "coder", sessionKey: "agent:coder:main" };

// Build a valid v2 dispatch payload (sender=bus → target=bus)
function validV2Payload(overrides = {}) {
  return {
    schema_version: "v2",
    protocol_version: "v2.0.0",
    dispatch_id: "00000000-0000-0000-0000-000000000aaa",
    parent_dispatch_id: null,
    original_dispatch_id: null,
    retry_count: 0,
    correlation_id: null,
    card_id: "00000000-0000-0000-0000-000000000bbb",
    parent_card_id: null,
    goal: "test goal — fix the bug",
    sender_role: "bus",
    sender_session_key: KNOWN_BUS_KEY,
    target_role: "work",
    target_session_key: KNOWN_WORK_KEY,
    context_payload: {
      task_spec: "fix the bug in X",
      extracted_history: "earlier we tried Y",
      acceptance_criteria: "tests pass + diff < 50 lines",
    },
    payload_completeness: "self_contained",
    priority: "normal",
    max_runtime_minutes: 60,
    acceptance_policy: {
      ac_owner: "dispatcher_bus",
      ac_immutable_by_worker: true,
      verifier: "dispatcher_bus",
      retry_on_fail: "close_and_redispatch",
      max_retry_count: 1,
    },
    expected_reply_format: "peer-contract-v2-reply-v1",
    // Day 5 P0 contract compliance: v1.1 peer-to-peer metadata fields included by default.
    // source: perspective agentId (matches ctx.agentId for normal dispatch flow)
    // reply_to: upstream session key this dispatch replies to (avoid agent:*:main unless authorized)
    source: "coder",
    reply_to: "agent:main:webchat:coder-handover",
    authorized_by: "Kelsen-Day-5-GO-2026-08-19-12:20",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Section: HR1 full (no-default-to-main) — pure validator tests
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 HR1: no-default-to-main (validator unit tests)");

await test("target=main → block (HR1)", () => {
  const errors = validateNoDefaultToMain("agent:coder:main");
  assertEq(errors.length, 1, "errors.length");
  assertEq(errors[0].hr, "HR1", "errors[0].hr");
  assertEq(errors[0].reason, "main_session_forbidden", "errors[0].reason");
});

// Day 6a followup (Mavis 2026-08-22 09:34, Kelsen report 9:06 Issue 1):
// intent-aware HR1. Default intent is "task_assignment" (conservative), so target=main still blocks.
// Explicit intents in mainIntentsAllowlist are allowed.

await test("target=main + intent=inform (in allowlist) → no HR1 error", () => {
  const errors = validateNoDefaultToMain("agent:coder:main", undefined, {
    intent: "inform",
    mainIntentsAllowlist: ["inform", "query", "sub-task"],
  });
  const mainErrors = errors.filter(e => e.reason === "main_session_forbidden");
  assertEq(mainErrors.length, 0, "should allow inform intent");
});

await test("target=main + intent=task_assignment (NOT in allowlist) → block (HR1)", () => {
  const errors = validateNoDefaultToMain("agent:coder:main", undefined, {
    intent: "task_assignment",
    mainIntentsAllowlist: ["inform", "query", "sub-task"],
  });
  assertEq(errors.some(e => e.reason === "main_session_forbidden"), true, "should block task_assignment");
});

await test("main→main + intent=inform (in allowlist) → no main-to-main error", () => {
  const errors = validateNoDefaultToMain("agent:kelsen:main", "agent:coder:main", {
    intent: "inform",
    mainIntentsAllowlist: ["inform"],
  });
  const mainToMainErrors = errors.filter(e => e.reason === "main_to_main_dispatch");
  assertEq(mainToMainErrors.length, 0, "inform intent allows main→main");
});

// Day 6a followup: cross-agent dispatch to work is forbidden (user architectural critique).

await test("cross-agent target=work → block (HR1 cross_agent_to_work)", () => {
  const workPattern = /^agent:[^:]+:work(:.*)?$/;
  const errors = validateNoDefaultToMain(
    "agent:coder:work:card-1:primary:xyz",
    "agent:kelsen:bus:webchat:test",
    { crossAgentToWorkBlocked: true, workSessionKeyPattern: workPattern }
  );
  assertEq(errors.some(e => e.reason === "cross_agent_to_work_forbidden"), true, "should block cross-agent work");
});

await test("same-agent target=work → no cross-agent error", () => {
  const workPattern = /^agent:[^:]+:work(:.*)?$/;
  const errors = validateNoDefaultToMain(
    "agent:coder:work:card-1:primary:xyz",
    "agent:coder:bus:dispatch-456",
    { crossAgentToWorkBlocked: true, workSessionKeyPattern: workPattern }
  );
  const crossAgentErrors = errors.filter(e => e.reason === "cross_agent_to_work_forbidden");
  assertEq(crossAgentErrors.length, 0, "same-agent work allowed");
});

// Day 6a+ followup (Mavis 2026-08-22 10:30, Kelsen #8 v2 feedback P1): workSessionKeyPattern
// now accepts "run:" prefix (OpenClaw's standard coder work session key) in addition to
// "work:". This ensures HR1 cross-agent-to-work check fires for both prefixes.

await test("cross-agent target=run (Kelsen P1 fix) → block (HR1 cross_agent_to_work)", () => {
  // Default workSessionKeyPattern now accepts both "work" and "run" (B 方案 policy default).
  const workPattern = /^agent:[^:]+:(work|run)(:.*)?$/;
  const errors = validateNoDefaultToMain(
    "agent:coder:run:card-1:primary:xyz",
    "agent:kelsen:bus:webchat:test",
    { crossAgentToWorkBlocked: true, workSessionKeyPattern: workPattern }
  );
  assertEq(errors.some(e => e.reason === "cross_agent_to_work_forbidden"), true, "should block cross-agent run");
});

await test("same-agent target=run → no cross-agent error", () => {
  const workPattern = /^agent:[^:]+:(work|run)(:.*)?$/;
  const errors = validateNoDefaultToMain(
    "agent:coder:run:card-1:primary:xyz",
    "agent:coder:bus:dispatch-456",
    { crossAgentToWorkBlocked: true, workSessionKeyPattern: workPattern }
  );
  const crossAgentErrors = errors.filter(e => e.reason === "cross_agent_to_work_forbidden");
  assertEq(crossAgentErrors.length, 0, "same-agent run allowed");
});

await test("target missing → block (HR1)", () => {
  const errors = validateNoDefaultToMain(undefined);
  assertEq(errors.length, 1, "errors.length");
  assertEq(errors[0].reason, "missing_target_session_key", "errors[0].reason");
});

await test("target=main + sender=main → block (HR1 main-to-main)", () => {
  const errors = validateNoDefaultToMain("agent:coder:main", "agent:coder:main");
  assertEq(errors.length, 2, "errors.length");
  assertEq(errors.some(e => e.reason === "main_to_main_dispatch"), true, "should flag main-to-main");
});

await test("target=work (uuid exists) → no HR1 errors", () => {
  const errors = validateNoDefaultToMain(KNOWN_WORK_KEY, KNOWN_BUS_KEY);
  assertEq(errors.length, 0, "errors.length");
});

await test("target=bus (uuid exists) → no HR1 errors", () => {
  const errors = validateNoDefaultToMain(KNOWN_BUS_KEY, KNOWN_BUS_KEY);
  assertEq(errors.length, 0, "errors.length");
});

// ──────────────────────────────────────────────────────────────────────────────
// Day 6a followup (Mavis 2026-08-22 09:53, user #8): correlation_id chain auto-fill
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 Day 6a: correlation_id chain auto-fill (validateDispatchSchema Step 2.5)");

await test("new task root: parent_dispatch_id=null, correlation_id=null → auto-filled to dispatch_id", () => {
  const params = validV2Payload({
    parent_dispatch_id: null,
    correlation_id: null,
    dispatch_id: "d-root-001",
  });
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  if (!v.ok) throw new Error(`expected ok, got: ${formatBlockReason(v.errors)}`);
  if (v.payload.correlation_id !== "d-root-001") {
    throw new Error(`correlation_id not auto-filled: ${v.payload.correlation_id}`);
  }
});

await test("sub-task: parent_dispatch_id set, original_dispatch_id=null → auto-filled to parent_dispatch_id", () => {
  const params = validV2Payload({
    parent_dispatch_id: "d-parent-001",
    correlation_id: "thread-abc",
    original_dispatch_id: null,
    dispatch_id: "d-child-001",
  });
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  if (!v.ok) throw new Error(`expected ok, got: ${formatBlockReason(v.errors)}`);
  if (v.payload.original_dispatch_id !== "d-parent-001") {
    throw new Error(`original_dispatch_id not auto-filled: ${v.payload.original_dispatch_id}`);
  }
});

await test("explicit correlation_id on new task root: not overridden", () => {
  const params = validV2Payload({
    parent_dispatch_id: null,
    correlation_id: "explicit-thread-xyz",
    dispatch_id: "d-root-002",
  });
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  if (!v.ok) throw new Error(`expected ok, got: ${formatBlockReason(v.errors)}`);
  if (v.payload.correlation_id !== "explicit-thread-xyz") {
    throw new Error(`explicit correlation_id was overridden: ${v.payload.correlation_id}`);
  }
});

await test("explicit original_dispatch_id on sub-task: not overridden", () => {
  const params = validV2Payload({
    parent_dispatch_id: "d-parent-002",
    correlation_id: "thread-def",
    original_dispatch_id: "d-grandparent-001",  // explicit chain root
    dispatch_id: "d-child-002",
  });
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  if (!v.ok) throw new Error(`expected ok, got: ${formatBlockReason(v.errors)}`);
  if (v.payload.original_dispatch_id !== "d-grandparent-001") {
    throw new Error(`explicit original_dispatch_id was overridden: ${v.payload.original_dispatch_id}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: HR6 session existence — pure validator tests
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 HR6: session existence (validator unit tests)");

await test("main session → valid (persistent)", () => {
  const errors = validateSessionExistence(undefined, "agent:coder:main", sessionRegistry);
  assertEq(errors.length, 0, "errors.length");
});

await test("registered bus session → valid", () => {
  const errors = validateSessionExistence(undefined, KNOWN_BUS_KEY, sessionRegistry);
  assertEq(errors.length, 0, "errors.length");
});

await test("registered work session → valid", () => {
  const errors = validateSessionExistence(undefined, KNOWN_WORK_KEY, sessionRegistry);
  assertEq(errors.length, 0, "errors.length");
});

await test("unregistered bus session target → invalid (HR6)", () => {
  const errors = validateSessionExistence("agent:coder:bus:never-registered", sessionRegistry);
  assertEq(errors.length, 1, "errors.length");
  assertEq(errors[0].hr, "HR6", "errors[0].hr");
  assertEq(errors[0].reason, "target_session_not_found", "errors[0].reason");
});

await test("random uuid work session → invalid (HR6)", () => {
  const errors = validateSessionExistence("agent:coder:work:card-xyz:primary:ffffffff-ffff-ffff-ffff-ffffffffffff", sessionRegistry);
  assertEq(errors.length, 1, "errors.length");
  assertEq(errors[0].reason, "target_session_not_found", "errors[0].reason");
});

await test("main session target → valid (always persistent)", () => {
  const errors = validateSessionExistence("agent:coder:main", sessionRegistry);
  assertEq(errors.length, 0, "errors.length");
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: HR8 payload-size
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 HR8: payload-size-cap");

await test("payload 60KB → pass", () => {
  const big = { message: "x".repeat(60000) };
  const r = validatePayloadSize(big, 65536);
  if (r.error) throw new Error(`expected pass, got error: ${r.error.message}`);
});

await test("payload 70KB → fail (HR8)", () => {
  const big = { message: "x".repeat(70000) };
  const r = validatePayloadSize(big, 65536);
  if (!r.error) throw new Error(`expected fail, got pass`);
  assertEq(r.error.hr, "HR8", "error.hr");
  assertEq(r.error.reason, "payload_size_exceeded", "error.reason");
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: HR6 schema validation — pure validator tests
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 HR6: v2 schema validation (validator unit tests)");

await test("complete payload → no schema errors", () => {
  const errors = validateV2Schema(validV2Payload());
  if (errors.length > 0) throw new Error(`expected no errors, got: ${JSON.stringify(errors)}`);
});

await test("missing schema_version → HR6", () => {
  const p = validV2Payload();
  delete p.schema_version;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "schema_version"), true, "should flag schema_version");
});

await test("missing dispatch_id → HR6", () => {
  const p = validV2Payload();
  delete p.dispatch_id;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "dispatch_id"), true, "should flag dispatch_id");
});

await test("missing sender_session_key → HR6", () => {
  const p = validV2Payload();
  delete p.sender_session_key;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "sender_session_key"), true, "should flag sender_session_key");
});

await test("missing target_session_key → HR6", () => {
  const p = validV2Payload();
  delete p.target_session_key;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "target_session_key"), true, "should flag target_session_key");
});

await test("missing goal → HR6", () => {
  const p = validV2Payload();
  delete p.goal;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "goal"), true, "should flag goal");
});

await test("missing context_payload → HR6", () => {
  const p = validV2Payload();
  delete p.context_payload;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "context_payload"), true, "should flag context_payload");
});

await test("missing context_payload.task_spec → HR6", () => {
  const p = validV2Payload();
  delete p.context_payload.task_spec;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "context_payload.task_spec"), true, "should flag task_spec");
});

await test("missing context_payload.acceptance_criteria → HR6", () => {
  const p = validV2Payload();
  delete p.context_payload.acceptance_criteria;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "context_payload.acceptance_criteria"), true, "should flag AC");
});

await test("missing acceptance_policy → HR6", () => {
  const p = validV2Payload();
  delete p.acceptance_policy;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "acceptance_policy"), true, "should flag acceptance_policy");
});

await test("missing acceptance_policy.ac_owner → HR6", () => {
  const p = validV2Payload();
  delete p.acceptance_policy.ac_owner;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "acceptance_policy.ac_owner"), true, "should flag ac_owner");
});

await test("missing max_runtime_minutes → HR6", () => {
  const p = validV2Payload();
  delete p.max_runtime_minutes;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "max_runtime_minutes"), true, "should flag max_runtime_minutes");
});

await test("missing expected_reply_format → HR6", () => {
  const p = validV2Payload();
  delete p.expected_reply_format;
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "expected_reply_format"), true, "should flag expected_reply_format");
});

await test("invalid priority → HR6", () => {
  const p = validV2Payload({ priority: "super-mega-urgent" });
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "priority" && e.reason === "invalid_priority"), true, "should flag priority");
});

await test("invalid payload_completeness → HR6", () => {
  const p = validV2Payload({ payload_completeness: "weird" });
  const errors = validateV2Schema(p);
  assertEq(errors.some(e => e.field === "payload_completeness"), true, "should flag payload_completeness");
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: Schema extraction (4 shapes)
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 schema extraction: 4 payload shapes");

await test("v2_top_level: payload at params top-level", () => {
  const p = validV2Payload();
  const r = extractDispatchPayload(p);
  assertEq(r.shape, "v2_top_level", "shape");
  assertEq(r.payload.schema_version, "v2", "payload.schema_version");
});

await test("v2_message_string: payload in params.message JSON string", () => {
  const p = { message: JSON.stringify(validV2Payload()) };
  const r = extractDispatchPayload(p);
  assertEq(r.shape, "v2_message_string", "shape");
  assertEq(r.payload.schema_version, "v2", "payload.schema_version");
  assertEq(r.targetSessionKey, KNOWN_WORK_KEY, "targetSessionKey");
});

await test("v2_message_object: payload in params.message object", () => {
  const p = { message: validV2Payload() };
  const r = extractDispatchPayload(p);
  assertEq(r.shape, "v2_message_object", "shape");
  assertEq(r.payload.schema_version, "v2", "payload.schema_version");
});

await test("legacy: params has sessionKey + plain message (no v2 fields)", () => {
  const p = { sessionKey: "agent:coder:bus:legacy-test", message: "hello world" };
  const r = extractDispatchPayload(p);
  assertEq(r.shape, "legacy", "shape");
  assertEq(r.targetSessionKey, "agent:coder:bus:legacy-test", "targetSessionKey");
});

await test("unknown: no schema_version + plain message + no sessionKey", () => {
  const p = { message: "just plain text" };
  const r = extractDispatchPayload(p);
  assertEq(r.shape, "unknown", "shape");
});

await test("unknown: v2 message string but malformed JSON", () => {
  const p = { message: "{ not valid json }" };
  const r = extractDispatchPayload(p);
  assertEq(r.shape, "unknown", "shape (should fall through)");
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: Full dispatch validation pipeline
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 full dispatch validation pipeline");

await test("valid v2 top-level + valid sessions → pass", () => {
  const params = validV2Payload();
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationOk(v);
  assertEq(v.resolvedShape, "v2_top_level", "resolvedShape");
  assertEq(v.targetSessionKey, KNOWN_WORK_KEY, "targetSessionKey");
});

await test("valid v2 in message-string + valid sessions → pass", () => {
  const params = { message: JSON.stringify(validV2Payload()) };
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationOk(v);
  assertEq(v.resolvedShape, "v2_message_string", "resolvedShape");
});

await test("valid v2 + target session not found → HR6 error", () => {
  const params = validV2Payload({ target_session_key: "agent:coder:work:card-xyz:primary:ffffffff-ffff-ffff-ffff-ffffffffffff" });
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationFail(v, /target_session_not_found/);
});

await test("valid v2 + target=main → HR1 error", () => {
  const params = validV2Payload({ target_session_key: "agent:coder:main" });
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationFail(v, /main_session_forbidden/);
});

await test("valid v2 + missing goal → HR6 + HR6 errors", () => {
  const params = validV2Payload();
  delete params.goal;
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationFail(v, /missing_goal/);
});

await test("payload too large → HR8 error (fail-fast)", () => {
  const params = validV2Payload({ goal: "x".repeat(70000) });
  const ctx = { sessionKey: KNOWN_BUS_KEY };
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationFail(v, /payload_size_exceeded/);
});

await test("legacy params (sessionKey + message) → pass with warning", () => {
  // We can't actually pass because the bus sessionKey is not registered.
  // Use a registered one:
  const params = { sessionKey: KNOWN_BUS_KEY, message: "hello bus" };
  const ctx = {};
  const v = validateDispatch(params, ctx, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationOk(v);
  assertEq(v.resolvedShape, "legacy", "resolvedShape");
  assertEq(v.warnings.length > 0, true, "should have warning for legacy");
});

await test("legacy params + unregistered target → HR6 fail", () => {
  const params = { sessionKey: "agent:coder:bus:never-registered-2", message: "hi" };
  const v = validateDispatch(params, {}, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationFail(v, /target_session_not_found/);
});

await test("unknown shape (plain text message + no sessionKey) → fail", () => {
  const params = { message: "plain text without any routing" };
  const v = validateDispatch(params, {}, { sessionRegistry, payloadSizeCapBytes: 65536 });
  assertValidationFail(v, /unresolvable_payload/);
});

await test("formatBlockReason: empty errors → empty string", () => {
  const r = formatBlockReason([]);
  assertEq(r, "", "formatBlockReason([])");
});

await test("formatBlockReason: groups by HR", () => {
  const errs = [
    { hr: "HR1", field: "target_session_key", message: "main forbidden", reason: "main_session_forbidden" },
    { hr: "HR6", field: "dispatch_id", message: "missing dispatch_id", reason: "missing_dispatch_id" },
    { hr: "HR6", field: "goal", message: "missing goal", reason: "missing_goal" },
  ];
  const r = formatBlockReason(errs);
  if (!r.includes("HR1") || !r.includes("HR6") || !r.includes("main forbidden") || !r.includes("missing dispatch_id") || !r.includes("missing goal")) {
    throw new Error(`unexpected format: ${r}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: Integration via toolGuard (bus → work dispatch)
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n📋 tool-guard integration: sessions_send");

await test("bus session sends v2 to registered work → allow", async () => {
  const event = { toolName: "sessions_send", params: validV2Payload() };
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result, "bus→work");
});

await test("bus session sends to unregistered bus → block (HR6)", async () => {
  const event = { toolName: "sessions_send", params: { sessionKey: "agent:coder:bus:never-registered-3", message: "hi" } };
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /target_session_not_found|HR6/, "bus→unregistered-bus");
});

await test("bus session sends target=main → block (HR1)", async () => {
  const event = { toolName: "sessions_send", params: { sessionKey: "agent:coder:main", message: "hi" } };
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR1.*main/, "bus→main");
});

await test("bus session sends v2 with missing goal → block (HR6)", async () => {
  const params = validV2Payload();
  delete params.goal;
  const event = { toolName: "sessions_send", params };
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR6.*goal/, "bus→work missing goal");
});

await test("work session sends to registered work (target_role=work) → block (HR2 inline already enforces)", async () => {
  // Day 3 inline HR2 already landed: work session can only send to bus (target_role='bus').
  // This test documents that work→work is blocked at Day 2.
  const event = { toolName: "sessions_send", params: validV2Payload({
    sender_role: "work",
    sender_session_key: KNOWN_WORK_KEY,
    target_role: "work",
    target_session_key: KNOWN_WORK_KEY,
  }) };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR2.*only send to bus/, "work→work (Day 3 HR2 inline blocks)");
});

await test("work session sends to nonexistent work → block (HR6 + HR9)", async () => {
  const event = { toolName: "sessions_send", params: validV2Payload({
    sender_role: "work",
    sender_session_key: KNOWN_WORK_KEY,
    target_role: "work",
    target_session_key: "agent:coder:work:card-xyz:primary:ffffffff-ffff-ffff-ffff-ffffffffffff",
  }) };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR6.*target_session_not_found|HR9.*HR6/, "work→nonexistent-work");
});

await test("main session sends to main → block (HR1 main-to-main)", async () => {
  const event = { toolName: "sessions_send", params: { sessionKey: "agent:coder:main", message: "hi" } };
  const result = await guard.beforeToolCall(event, mainCtx);
  assertBlock(result, /HR1/, "main→main");
});

await test("non-sessions_send tool with HR8 violation → block", async () => {
  const event = { toolName: "read", params: { path: "/tmp/" + "x".repeat(70000) } };
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR8.*payload size/, "read tool HR8");
});

await test("work session uses denied tool (message) → block (HR9)", async () => {
  const event = { toolName: "message", params: { action: "send", channel: "qq", target: "x", message: "hi" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR9.*message/, "work session message tool");
});

await test("work session allowed tool (read) → allow", async () => {
  const event = { toolName: "read", params: { path: "/tmp/foo" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertOk(result, "work session read tool");
});

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(40));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📊 Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}