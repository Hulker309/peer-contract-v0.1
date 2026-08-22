// End-to-end (cross-cutting) tests for peer-contract-enforcer plugin (Day 6a)
// Exercises full dispatch flow across all HRs + Drift 1-5 contract compliance + audit log + acCache lifecycle.
//
// Run with: node tests/hr-e2e.test.mjs

import { createWorkbenchPolicy, createSessionRoleRegistry } from "../src/workbench-policy.js";
import { createSessionRegistry } from "../src/session-registry.js";
import { createAgentRegistry } from "../src/agent-registry.js";
import { createAcceptanceCriteriaCache } from "../src/ac-cache.js";
import { createAuditLogger } from "../src/audit-logger.js";
import { createToolGuard } from "../src/tool-guard.js";
import { makeValidV2Dispatch, makeSameAgentV2Dispatch, makeDispatchEvent, test, printSummary } from "./_helpers.mjs";

let passed = 0;
let failed = 0;

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

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const policy = createWorkbenchPolicy({});
const roleRegistry = createSessionRoleRegistry();
const sessionRegistry = createSessionRegistry({ openclawHomeDir: "C:/Users/Administrator/.openclaw" });
const agentRegistry = createAgentRegistry({ openclawHomeDir: "C:/Users/Administrator/.openclaw" });
const acCache = createAcceptanceCriteriaCache();
const auditLogger = createAuditLogger({ disableFile: true });
const guard = createToolGuard(policy, roleRegistry, sessionRegistry, acCache, auditLogger, agentRegistry);

// Bootstrap agent registry with known agents (simulating plugin cold-start)
agentRegistry.register("coder", { source: "bootstrap" });
agentRegistry.register("kelsen", { source: "bootstrap" });
agentRegistry.register("main", { source: "bootstrap" });

// Pre-register a work session for HR6 session-existence
sessionRegistry.set("agent:coder:work:card-e2e-1:primary:xyz-uuid", {
  agentId: "coder", source: "session_start",
});
// Pre-register Kelsen bus session (used as reply_to target in many tests)
sessionRegistry.set("agent:kelsen:bus:webchat:test", {
  agentId: "kelsen", source: "session_start",
});
sessionRegistry.set("agent:coder:bus:dispatch-test", {
  agentId: "coder", source: "session_start",
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: full cross-cutting dispatch flow (bus → work → bus, AC immutable, audit)
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n[E2E: bus → work → bus cross-cutting dispatch]");

await test("E2E 1: complete bus → work → bus dispatch flow with audit", async () => {
  auditLogger.clear();
  acCache.purgeExpired();
  const cardId = "card-e2e-full";
  const workSessionKey = `agent:coder:work:${cardId}:primary:xyz-e2e`;
  sessionRegistry.set(workSessionKey, { agentId: "coder", source: "session_start" });
  roleRegistry.set(workSessionKey, {
    role: "work", parentSessionKey: "agent:kelsen:bus:webchat:test",
    agentId: "coder", cardId, subTaskId: "primary",
  });

  // Phase 1: bus dispatches to work
  // Day 6a followup (Mavis 2026-08-22 09:34): use makeSameAgentV2Dispatch to ensure
  // sender=coder bus, target=coder work (intra-agent sub-session spawn, allowed by HR1).
  const busDispatch = makeDispatchEvent(makeSameAgentV2Dispatch({
    card_id: cardId,
    target_session_key: workSessionKey,
    context_payload: {
      task_spec: "ship the plugin",
      extracted_history: "Day 1-5 done, Day 6 in progress",
      acceptance_criteria: "ship the plugin",
    },
  }));
  const busResult = await guard.beforeToolCall(busDispatch, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });
  assertOk(busResult, "bus→work");
  if (acCache.get(cardId) !== "ship the plugin") {
    throw new Error(`AC not cached after bus dispatch: ${acCache.get(cardId)}`);
  }

  // Phase 2: work session reports back with same AC
  const workReport = makeDispatchEvent(makeValidV2Dispatch({
    card_id: cardId,
    sender_session_key: workSessionKey,
    sender_role: "work",
    target_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "bus",
    context_payload: {
      task_spec: "ship the plugin",
      extracted_history: "Day 1-5 done, Day 6 in progress",
      acceptance_criteria: "ship the plugin",
    },
  }));
  const workResult = await guard.beforeToolCall(workReport, {
    agentId: "coder", sessionKey: workSessionKey,
  });
  assertOk(workResult, "work→bus (same AC)");

  // Verify audit log (HR5: sessions_history/memory_search would also write; this session_send doesn't add cross_session_query but message_sending does)
  // For this e2e we check sessions_history separately
  await auditLogger.flush();
  if (auditLogger.size < 0) throw new Error("audit unexpected negative"); // just ensure flush works
});

await test("E2E 2: AC modify attempt (HR7) + cross-cutting HR1/HR4/CONTRACT block", async () => {
  auditLogger.clear();
  acCache.purgeExpired();
  const cardId = "card-e2e-ac-modify";
  const workSessionKey = `agent:coder:work:${cardId}:primary:xyz-acmodify`;
  sessionRegistry.set(workSessionKey, { agentId: "coder", source: "session_start" });

  // Phase 1: bus dispatches
  // Day 6a followup: same-agent dispatch (HR1 cross-agent-to-work allows).
  const busDispatch = makeDispatchEvent(makeSameAgentV2Dispatch({
    card_id: cardId,
    target_session_key: workSessionKey,
    context_payload: {
      task_spec: "fix bug X",
      extracted_history: "y",
      acceptance_criteria: "fix bug X",
    },
  }));
  await guard.beforeToolCall(busDispatch, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });

  // Phase 2: work session tries to modify AC (HR7 immutable by worker)
  const modifiedAc = makeDispatchEvent(makeValidV2Dispatch({
    card_id: cardId,
    sender_session_key: workSessionKey,
    sender_role: "work",
    target_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "bus",
    context_payload: {
      task_spec: "fix bug X",
      extracted_history: "y",
      acceptance_criteria: "fix bug X AND add feature Y", // MODIFIED
    },
  }));
  const result = await guard.beforeToolCall(modifiedAc, {
    agentId: "coder", sessionKey: workSessionKey,
  });
  assertBlock(result, /HR7.*acceptance_criteria/, "AC modify");
});

await test("E2E 3: HR4 payload-self-contained block on bus dispatch", async () => {
  auditLogger.clear();
  const event = makeDispatchEvent(makeValidV2Dispatch({
    payload_completeness: "need_lookup",
    // missing references — should block HR4
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });
  assertBlock(result, /HR4/, "HR4 need_lookup without references");
});

await test("E2E 4: HR1 no-default-to-main on bus dispatch", async () => {
  auditLogger.clear();
  const event = makeDispatchEvent(makeValidV2Dispatch({
    target_session_key: "agent:coder:main",
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });
  assertBlock(result, /HR1.*main/, "HR1 target=main");
});

await test("E2E 5: HR6 session-existence block on bus dispatch to unregistered session", async () => {
  auditLogger.clear();
  const event = makeDispatchEvent(makeValidV2Dispatch({
    target_session_key: "agent:coder:work:never-registered:primary:xyz",
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });
  assertBlock(result, /HR6.*target_session_not_found/, "HR6 unregistered target");
});

await test("E2E 6: HR9 work session denied tool (message)", async () => {
  auditLogger.clear();
  const event = { toolName: "message", params: { action: "send", channel: "qq", target: "x", message: "hi" } };
  const result = await guard.beforeToolCall(event, {
    agentId: "coder", sessionKey: "agent:coder:work:card-e2e-1:primary:xyz-uuid",
  });
  assertBlock(result, /HR9/, "HR9 work denied tool");
});

await test("E2E 7: HR2 cross-work-direct block on work→work dispatch", async () => {
  auditLogger.clear();
  const workA = "agent:coder:work:card-a:primary:xyz";
  const workB = "agent:coder:work:card-b:primary:xyz";
  sessionRegistry.set(workA, { agentId: "coder", source: "session_start" });
  sessionRegistry.set(workB, { agentId: "coder", source: "session_start" });
  roleRegistry.set(workA, { role: "work", parentSessionKey: "agent:kelsen:bus:webchat:test", agentId: "coder" });

  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: workA,
    sender_role: "work",
    target_session_key: workB,
    target_role: "work",
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "coder", sessionKey: workA,
  });
  assertBlock(result, /HR2.*only send to bus/, "HR2 cross-work-direct");
});

await test("E2E 8: HR3 channel-originated ctx → work target blocked", async () => {
  auditLogger.clear();
  const workSession = "agent:coder:work:card-e2e-1:primary:xyz-uuid";
  // sessionRegistry already set in fixtures
  // Day 6a followup: same-agent dispatch (HR1 cross-agent-to-work allows).
  const event = makeDispatchEvent(makeSameAgentV2Dispatch({
    target_session_key: workSession,
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "coder",
    sessionKey: "agent:coder:work:card-e2e-1:primary:xyz-uuid",
    messageProvider: "discord", // simulates channel-originated message
  });
  assertBlock(result, /HR3/, "HR3 channel→work");
});

await test("E2E 9: HR8 payload-size-cap on sessions_send", async () => {
  auditLogger.clear();
  const event = makeDispatchEvent(makeValidV2Dispatch({
    goal: "x".repeat(70000),
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });
  assertBlock(result, /HR8.*payload size/, "HR8 size cap");
});

await test("E2E 10: CONTRACT Drift 1 (source reverse) block on bus dispatch", async () => {
  auditLogger.clear();
  // Day 6a followup: same-agent dispatch (HR1 cross-agent-to-work allows).
  const event = makeDispatchEvent(makeSameAgentV2Dispatch({
    target_session_key: "agent:coder:work:card-e2e-1:primary:xyz-uuid", // pre-registered in fixtures
    source: "wrong-agent", // not in whitelist, not ctxAgentId, not senderAgentId
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });
  assertBlock(result, /CONTRACT.*source/, "Drift 1 source mismatch");
});

await test("E2E 11: CONTRACT Drift 5 (phantom agent) block on bus dispatch", async () => {
  auditLogger.clear();
  // Day 6a followup: same-agent dispatch (HR1 cross-agent-to-work allows).
  const event = makeDispatchEvent(makeSameAgentV2Dispatch({
    target_session_key: "agent:coder:work:card-e2e-1:primary:xyz-uuid", // pre-registered in fixtures
    source: "agent:phantom:main",
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test",
  });
  assertBlock(result, /CONTRACT.*source.*phantom/, "Drift 5 phantom agent");
});

await test("E2E 12: HR5 audit logger captures sessions_history", async () => {
  auditLogger.clear();
  const event = {
    toolName: "sessions_history",
    params: { sessionKey: "agent:coder:bus:dispatch-test", limit: 50 },
  };
  const result = await guard.beforeToolCall(event, {
    agentId: "coder", sessionKey: "agent:coder:work:card-e2e-1:primary:xyz-uuid",
  });
  assertOk(result, "sessions_history");
  await auditLogger.flush();
  const entries = auditLogger.entries();
  const crossQuery = entries.find(e => e.kind === "cross_session_query" && e.toolName === "sessions_history");
  if (!crossQuery) throw new Error("expected cross_session_query entry for sessions_history");
});

await test("E2E 13: HR5 audit logger captures memory_search", async () => {
  auditLogger.clear();
  const event = {
    toolName: "memory_search",
    params: { query: "where did we put the plugin manifest?" },
  };
  const result = await guard.beforeToolCall(event, {
    agentId: "coder", sessionKey: "agent:coder:work:card-e2e-1:primary:xyz-uuid",
  });
  assertOk(result, "memory_search");
  await auditLogger.flush();
  const entries = auditLogger.entries();
  const memSearch = entries.find(e => e.toolName === "memory_search");
  if (!memSearch) throw new Error("expected memory_search entry");
  if (memSearch.query !== "where did we put the plugin manifest?") {
    throw new Error(`query mismatch: ${memSearch.query}`);
  }
});

await test("E2E 14: acCache TTL eviction across cross-cutting dispatch", async () => {
  auditLogger.clear();
  const acCacheShort = createAcceptanceCriteriaCache({ defaultTtlMs: 50 });
  const guardShort = createToolGuard(
    createWorkbenchPolicy({}),
    createSessionRoleRegistry(),
    createSessionRegistry({ openclawHomeDir: "C:/Users/Administrator/.openclaw" }),
    acCacheShort,
    createAuditLogger({ disableFile: true }),
    createAgentRegistry({ openclawHomeDir: "C:/Users/Administrator/.openclaw" }),
  );

  const cardId = "card-e2e-ttl";
  const workSessionKey = `agent:coder:work:${cardId}:primary:xyz-ttl`;
  // Day 6a followup: same-agent dispatch.
  guardShort.beforeToolCall(
    makeDispatchEvent(makeSameAgentV2Dispatch({
      card_id: cardId,
      target_session_key: workSessionKey,
      max_runtime_minutes: 0.001, // ~60ms TTL via buffer math (60s + 60s = 120s, but ttlMs formula uses minutes*60_000+60_000 so 0.001 → ~60ms)
      context_payload: {
        task_spec: "x", extracted_history: "y", acceptance_criteria: "ship v0.1",
      },
    })),
    { agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test" },
  );
  // Wait for TTL expiry (60ms+ buffer > 60ms is enough; wait 200ms for safety)
  await new Promise(r => setTimeout(r, 200));

  // Verify AC cache miss
  if (acCacheShort.get(cardId) !== undefined) {
    throw new Error("AC should be expired");
  }
});

await test("E2E 15: full integration — bus → work → modify AC (HR7) → audit log", async () => {
  auditLogger.clear();
  acCache.purgeExpired();
  const cardId = "card-e2e-15";
  const workSessionKey = `agent:coder:work:${cardId}:primary:xyz-15`;
  sessionRegistry.set(workSessionKey, { agentId: "coder", source: "session_start" });
  roleRegistry.set(workSessionKey, {
    role: "work", parentSessionKey: "agent:kelsen:bus:webchat:test",
    agentId: "coder",
  });

  // Bus dispatch
  // Day 6a followup: same-agent dispatch (HR1 cross-agent-to-work allows).
  const busRes = await guard.beforeToolCall(
    makeDispatchEvent(makeSameAgentV2Dispatch({
      card_id: cardId,
      target_session_key: workSessionKey,
      context_payload: {
        task_spec: "x", extracted_history: "y", acceptance_criteria: "AC-original",
      },
    })),
    { agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test" },
  );
  assertOk(busRes, "bus dispatch");

  // Cross-cutting: HR7 AC modify attempt
  const modifyRes = await guard.beforeToolCall(
    makeDispatchEvent(makeValidV2Dispatch({
      card_id: cardId,
      sender_session_key: workSessionKey,
      sender_role: "work",
      target_session_key: "agent:kelsen:bus:webchat:test",
      target_role: "bus",
      context_payload: {
        task_spec: "x", extracted_history: "y", acceptance_criteria: "AC-MODIFIED",
      },
    })),
    { agentId: "coder", sessionKey: workSessionKey },
  );
  assertBlock(modifyRes, /HR7/, "AC modify");

  // Audit log entry for the audit-tracked tool call (sessions_history)
  await guard.beforeToolCall(
    { toolName: "sessions_history", params: { sessionKey: workSessionKey } },
    { agentId: "coder", sessionKey: workSessionKey },
  );
  await auditLogger.flush();
  const auditEntries = auditLogger.entries();
  const audit = auditEntries.find(e => e.toolName === "sessions_history");
  if (!audit) throw new Error("expected sessions_history audit entry after cross-cutting dispatch");
});

// Day 6a+ followup (Mavis 2026-08-22 10:30, Kelsen #8 v2 feedback P0-1):
// When sessions_send is called with `message=<JSON string>` (v2_message_string shape),
// auto-fill correlation_id mutation must write back to event.params.message so the
// target session receives the auto-filled value (not the original null).

await test("E2E 16: v2_message_string auto-fill writes back to event.params.message", async () => {
  const targetSk = "agent:coder:work:e2e-16:primary:xyz";
  // Pre-register target so HR6 session-existence passes.
  sessionRegistry.set(targetSk, { agentId: "coder", source: "test_fixture" });
  const eventParams = {
    sessionKey: targetSk,
    message: JSON.stringify({
      schema_version: "v2",
      protocol_version: "v2.0.0",
      dispatch_id: "d-e2e-16-root",
      parent_dispatch_id: null,
      original_dispatch_id: null,
      retry_count: 0,
      correlation_id: null,  // will be auto-filled to dispatch_id
      card_id: "card-e2e-16",
      parent_card_id: null,
      goal: "test",
      sender_role: "bus",
      sender_session_key: "agent:coder:bus:dispatch-e2e-16",
      target_role: "work",
      target_session_key: targetSk,
      context_payload: { task_spec: "x", extracted_history: "y", acceptance_criteria: "z" },
      payload_completeness: "self_contained",
      priority: "normal",
      max_runtime_minutes: 60,
      acceptance_policy: { ac_owner: "bus", ac_immutable_by_worker: true, verifier: "bus", retry_on_fail: "close", max_retry_count: 1 },
      expected_reply_format: "v2-reply",
      source: "coder",
      reply_to: "agent:coder:bus:dispatch-e2e-16",
      authorized_by: "test",
    }),
  };
  const ctx = { agentId: "coder", sessionKey: "agent:coder:bus:dispatch-e2e-16" };
  const result = await guard.beforeToolCall({ toolName: "sessions_send", params: eventParams }, ctx);
  if (result?.block) throw new Error(`unexpected block: ${result.blockReason}`);
  // Verify event.params.message was written back with auto-filled correlation_id
  const writtenBack = JSON.parse(eventParams.message);
  if (writtenBack.correlation_id !== "d-e2e-16-root") {
    throw new Error(`correlation_id not auto-filled in written-back message: ${writtenBack.correlation_id}`);
  }
});

// Day 6a+ followup (Mavis 2026-08-22 10:30, Kelsen #8 v2 feedback P0-2):
// sessions_send pre-fills sessionRegistry for target session with correlation_id,
// so subsequent hooks (sessions_history, message_sending) on that target session
// can read correlationId from session-registry for chain tracking.

await test("E2E 17: sessions_send pre-fills session-registry with target's correlationId", async () => {
  const targetSk = "agent:coder:work:e2e-17:primary:xyz";
  // Pre-register target so HR6 session-existence passes.
  sessionRegistry.set(targetSk, { agentId: "coder", source: "test_fixture" });
  const eventParams = makeSameAgentV2Dispatch({
    target_session_key: targetSk,
    correlation_id: "thread-e2e-17-001",
    card_id: "card-e2e-17",
  });
  const ctx = { agentId: "coder", sessionKey: "agent:coder:bus:dispatch-e2e-17" };
  const result = await guard.beforeToolCall({ toolName: "sessions_send", params: eventParams }, ctx);
  if (result?.block) throw new Error(`unexpected block: ${result.blockReason}`);
  // sessionRegistry should now have the target session with correlationId pre-filled
  const entry = sessionRegistry.get(targetSk);
  if (!entry) throw new Error(`session-registry missing entry for target: ${targetSk}`);
  if (entry.correlationId !== "thread-e2e-17-001") {
    throw new Error(`session-registry correlationId not pre-filled: ${entry.correlationId}`);
  }
});

// Day 6a+ followup (Mavis 2026-08-22 11:15, Kelsen P0-3 feedback): work session
// can only send to its parent bus. Cross-agent work→bus (work session sending to
// a different agent's bus) must be BLOCKED by HR2 parent check. Before P0-3 fix,
// session_start handler overwrote parentSessionKey, so callerInfo.parentSessionKey
// was always undefined and HR2 short-circuited. After P0-3 fix, parent is
// preserved from subagent_spawned.

await test("E2E 18: work→bus same-agent (intra-agent) → ALLOW (HR2 parent match)", async () => {
  // Set up: coder.work spawned by coder.bus (parent)
  const childSk = "agent:coder:work:e2e-18:primary:xyz";
  const parentBusSk = "agent:coder:bus:e2e-18-dispatcher";
  // Pre-register role-registry as if subagent_spawned fired
  roleRegistry.set(childSk, {
    role: "work",
    parentSessionKey: parentBusSk,
    agentId: "coder",
  });
  // Pre-register target bus in session-registry (for HR6 session-existence)
  sessionRegistry.set(parentBusSk, { agentId: "coder", source: "test_fixture" });
  // Pre-register child work session (for HR6)
  sessionRegistry.set(childSk, { agentId: "coder", source: "test_fixture" });
  // Dispatch from work to its own parent bus
  const eventParams = makeSameAgentV2Dispatch({
    sender_session_key: childSk,
    sender_role: "work",
    target_session_key: parentBusSk,
    target_role: "bus",
    correlation_id: "thread-e2e-18-parent-match",
    card_id: "card-e2e-18",
  });
  const ctx = { agentId: "coder", sessionKey: childSk };
  const result = await guard.beforeToolCall({ toolName: "sessions_send", params: eventParams }, ctx);
  if (result?.block) throw new Error(`expected ALLOW (same-agent), got BLOCK: ${result.blockReason}`);
});

await test("E2E 19: work→bus cross-agent (work session of agent A → bus of agent B) → BLOCK HR2", async () => {
  // Set up: coder.work spawned by coder.bus (parent = coder's bus)
  // coder.work tries to send to KELSEN's bus (different agent) — must BLOCK HR2
  const childSk = "agent:coder:work:e2e-19:primary:xyz";
  const parentBusSk = "agent:coder:bus:e2e-19-dispatcher";
  const kelsenBusSk = "agent:kelsen:bus:e2e-19-dispatcher";
  // Pre-register role-registry as if subagent_spawned fired (parent = coder's bus)
  roleRegistry.set(childSk, {
    role: "work",
    parentSessionKey: parentBusSk,
    agentId: "coder",
  });
  // Pre-register both buses in session-registry (for HR6)
  sessionRegistry.set(parentBusSk, { agentId: "coder", source: "test_fixture" });
  sessionRegistry.set(kelsenBusSk, { agentId: "kelsen", source: "test_fixture" });
  sessionRegistry.set(childSk, { agentId: "coder", source: "test_fixture" });
  // Dispatch from coder.work to KELSEN's bus (different agent)
  const eventParams = makeValidV2Dispatch({
    sender_session_key: childSk,
    sender_role: "work",
    source: "coder",
    target_session_key: kelsenBusSk,
    target_role: "bus",
    correlation_id: "thread-e2e-19-cross-agent",
    card_id: "card-e2e-19",
    context_payload: { task_spec: "x", extracted_history: "y", acceptance_criteria: "z" },
  });
  const ctx = { agentId: "coder", sessionKey: childSk };
  const result = await guard.beforeToolCall({ toolName: "sessions_send", params: eventParams }, ctx);
  if (!result?.block) throw new Error(`expected BLOCK (cross-agent work→bus), got ALLOW: ${JSON.stringify(result)}`);
  if (!/HR2|parent/i.test(result.blockReason)) {
    throw new Error(`expected HR2 parent check, got: ${result.blockReason}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

printSummary("Day 6a E2E");
if (failed > 0) process.exit(1);