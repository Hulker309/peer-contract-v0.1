// HR4 + HR7 unit tests (Day 4)
// Pure ESM .mjs, no TypeScript
// Run with: node tests/hr4-hr7.test.mjs

import { createWorkbenchPolicy } from "../src/workbench-policy.js";
import { createSessionRoleRegistry } from "../src/role-registry.js";
import { createAcceptanceCriteriaCache } from "../src/ac-cache.js";
import { createToolGuard } from "../src/tool-guard.js";
import { validatePayloadSelfContained } from "../src/dispatch-validator.js";
import { test, assertOk, assertBlock, printSummary, makeValidV2Dispatch, makeDispatchEvent } from "./_helpers.mjs";

console.log("\n[HR4: payload-self-contained validator (unit)]");

await test("self_contained with no references → ok", () => {
  const cp = { payload_completeness: "self_contained", task_spec: "x", extracted_history: "y", acceptance_criteria: "z" };
  const result = validatePayloadSelfContained(cp);
  if (!result.ok) throw new Error(result.reason);
});

await test("need_lookup with valid references → ok", () => {
  const cp = {
    payload_completeness: "need_lookup",
    task_spec: "x", extracted_history: "y", acceptance_criteria: "z",
    references: [
      { type: "session", locator: "agent:coder:bus:dispatch-123", note: "prior bus context" },
      { type: "file", locator: "/path/to/spec.md", note: "design spec" },
    ],
  };
  const result = validatePayloadSelfContained(cp);
  if (!result.ok) throw new Error(result.reason);
});

await test("need_lookup without references → block", () => {
  const cp = { payload_completeness: "need_lookup", task_spec: "x", extracted_history: "y", acceptance_criteria: "z" };
  const result = validatePayloadSelfContained(cp);
  if (result.ok) throw new Error("expected fail");
  if (!/need_lookup.*requires non-empty references/.test(result.reason)) throw new Error(`wrong reason: ${result.reason}`);
});

await test("invalid payload_completeness → block", () => {
  const cp = { payload_completeness: "unknown", task_spec: "x", extracted_history: "y", acceptance_criteria: "z" };
  const result = validatePayloadSelfContained(cp);
  if (result.ok) throw new Error("expected fail");
});

await test("references not array → block", () => {
  const cp = { references: "not an array", task_spec: "x", extracted_history: "y", acceptance_criteria: "z", payload_completeness: "self_contained" };
  const result = validatePayloadSelfContained(cp);
  if (result.ok) throw new Error("expected fail");
});

await test("reference missing type → block", () => {
  const cp = { payload_completeness: "need_lookup", task_spec: "x", extracted_history: "y", acceptance_criteria: "z", references: [{ locator: "x" }] };
  const result = validatePayloadSelfContained(cp);
  if (result.ok) throw new Error("expected fail");
});

await test("reference invalid type → block", () => {
  const cp = { payload_completeness: "need_lookup", task_spec: "x", extracted_history: "y", acceptance_criteria: "z", references: [{ type: "invalid", locator: "x" }] };
  const result = validatePayloadSelfContained(cp);
  if (result.ok) throw new Error("expected fail");
});

await test("reference missing locator → block", () => {
  const cp = { payload_completeness: "need_lookup", task_spec: "x", extracted_history: "y", acceptance_criteria: "z", references: [{ type: "file" }] };
  const result = validatePayloadSelfContained(cp);
  if (result.ok) throw new Error("expected fail");
});

await test("url reference without http(s) → block", () => {
  const cp = { payload_completeness: "need_lookup", task_spec: "x", extracted_history: "y", acceptance_criteria: "z", references: [{ type: "url", locator: "ftp://x" }] };
  const result = validatePayloadSelfContained(cp);
  if (result.ok) throw new Error("expected fail");
});

console.log("\n[HR4: integrated via before_tool_call (full v0.1 dispatch)]");

const policy = createWorkbenchPolicy({});
const roleRegistry = createSessionRoleRegistry();
const acCache = createAcceptanceCriteriaCache();
const guard = createToolGuard(policy, roleRegistry, undefined, acCache);

const busCtx = { agentId: "kelsen", sessionKey: "agent:kelsen:bus:webchat:test" };

await test("bus dispatch self_contained (default) → allow", async () => {
  // Day 6a followup (Mavis 2026-08-22 09:34): default sender=kelsen, target=coder work
  // is now blocked by HR1 cross-agent-to-work. Override sender to coder for same-agent
  // case (intra-agent sub-session spawn, allowed).
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:bus:dispatch-456",
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("bus dispatch need_lookup + valid references → allow", async () => {
  // Day 6a followup: same-agent case for HR4 payload self-contained test.
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:bus:dispatch-456",
    payload_completeness: "need_lookup",
    context_payload: {
      task_spec: "x", extracted_history: "y", acceptance_criteria: "z",
      references: [{ type: "card", locator: "abc", note: "linked" }],
    },
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("bus dispatch need_lookup without references → block HR4", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    payload_completeness: "need_lookup",
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR4/);
});

await test("bus dispatch invalid reference type → block HR4", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    payload_completeness: "need_lookup",
    context_payload: {
      task_spec: "x", extracted_history: "y", acceptance_criteria: "z",
      references: [{ type: "bogus", locator: "x" }],
    },
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR4/);
});

console.log("\n[HR7: immutable-AC-by-worker]");

// Setup: bus dispatch first to populate AC cache
// Day 6a followup (Mavis 2026-08-22 09:34): default sender=kelsen, target=coder work
// is now blocked by HR1 cross-agent-to-work. Override sender to coder for same-agent
// case (intra-agent sub-session spawn, allowed) so setup can populate AC cache.
const setupEvent = makeDispatchEvent(makeValidV2Dispatch({
  card_id: "card-hr7-test",
  sender_session_key: "agent:coder:bus:dispatch-456",
}));
await guard.beforeToolCall(setupEvent, busCtx);

roleRegistry.set("agent:coder:work:card-hr7-test:primary:xyz", {
  role: "work",
  parentSessionKey: "agent:kelsen:bus:webchat:test",
  agentId: "coder",
  cardId: "card-hr7-test",
  subTaskId: "primary",
});

await test("work session sends to parent bus with SAME AC → allow", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-hr7-test",
    sender_session_key: "agent:coder:work:card-hr7-test:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "bus",
    context_payload: {
      task_spec: "report back", extracted_history: "y", acceptance_criteria: "9 HR tests pass",
    },
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "coder",
    sessionKey: "agent:coder:work:card-hr7-test:primary:xyz",
  });
  assertOk(result);
});

await test("work session tries to MODIFY AC → block HR7", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-hr7-test",
    sender_session_key: "agent:coder:work:card-hr7-test:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "bus",
    context_payload: {
      task_spec: "report back", extracted_history: "y",
      acceptance_criteria: "9 HR tests pass + 11 HR tests pass", // CHANGED
    },
  }));
  const result = await guard.beforeToolCall(event, {
    agentId: "coder",
    sessionKey: "agent:coder:work:card-hr7-test:primary:xyz",
  });
  assertBlock(result, /HR7.*modify acceptance_criteria/);
});

await test("work session tries different card (no cached AC) → allow", async () => {
  const roleRegistry5 = createSessionRoleRegistry();
  const acCache5 = createAcceptanceCriteriaCache();
  const guard5 = createToolGuard(policy, roleRegistry5, undefined, acCache5);
  
  roleRegistry5.set("agent:coder:work:card-different:primary:xyz", {
    role: "work",
    parentSessionKey: "agent:kelsen:bus:webchat:test",
    agentId: "coder",
    cardId: "card-different",
    subTaskId: "primary",
  });
  
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-different",
    sender_session_key: "agent:coder:work:card-different:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "bus",
    context_payload: {
      task_spec: "report back", extracted_history: "y", acceptance_criteria: "different AC",
    },
  }));
  const result = await guard5.beforeToolCall(event, {
    agentId: "coder",
    sessionKey: "agent:coder:work:card-different:primary:xyz",
  });
  assertOk(result);
});

console.log("\n[End-to-end HR4 + HR7]");

await test("bus → work sets AC → work → bus with same AC → allow", async () => {
  const acCache2 = createAcceptanceCriteriaCache();
  const roleRegistry2 = createSessionRoleRegistry();
  const guard2 = createToolGuard(policy, roleRegistry2, undefined, acCache2);
  
  // Step 1: bus dispatches work with AC
  const busDispatch = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e",
    context_payload: {
      task_spec: "ship plugin", extracted_history: "y", acceptance_criteria: "ship plugin",
    },
  }));
  await guard2.beforeToolCall(busDispatch, busCtx);
  
  // Step 2: work session registered
  roleRegistry2.set("agent:coder:work:card-e2e:primary:xyz", {
    role: "work",
    parentSessionKey: "agent:kelsen:bus:webchat:test",
    agentId: "coder",
    cardId: "card-e2e",
    subTaskId: "primary",
  });
  
  // Step 3: work session reports back with same AC
  const workReport = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e",
    sender_session_key: "agent:coder:work:card-e2e:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "bus",
    context_payload: {
      task_spec: "ship plugin", extracted_history: "y", acceptance_criteria: "ship plugin",
    },
  }));
  const result = await guard2.beforeToolCall(workReport, {
    agentId: "coder",
    sessionKey: "agent:coder:work:card-e2e:primary:xyz",
  });
  assertOk(result);
});

console.log("\n[Day 4 regression fixtures: Kelsen contract_compliance drift]");

import { validateContractCompliance } from "../src/contract-compliance.js";

await test("Drift 1: source ≠ sender agentId → block (CONTRACT)", () => {
  const params = makeValidV2Dispatch({ source: "wrong-agent-id" });
  const ctx = { agentId: "kelsen" };
  const errors = validateContractCompliance(params, ctx);
  if (errors.length === 0) throw new Error("expected block");
  if (!errors.some(e => e.field === "source" && e.reason === "source_must_equal_sender_agent_id")) {
    throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
  }
});

await test("Drift 1 positive: source === sender agentId → allow", () => {
  const params = makeValidV2Dispatch({ source: "kelsen" });
  const ctx = { agentId: "kelsen" };
  const errors = validateContractCompliance(params, ctx);
  if (errors.length > 0) throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
});

await test("Drift 2: reply_to missing → block (CONTRACT)", () => {
  const params = makeValidV2Dispatch();
  delete params.reply_to;
  const errors = validateContractCompliance(params, {});
  if (errors.length === 0) throw new Error("expected block");
  if (!errors.some(e => e.field === "reply_to" && e.reason === "reply_to_missing")) {
    throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
  }
});

await test("Drift 3: decision_needed field → block (CONTRACT)", () => {
  const params = makeValidV2Dispatch({ decision_needed: "yes please" });
  const errors = validateContractCompliance(params, {});
  if (errors.length === 0) throw new Error("expected block");
  if (!errors.some(e => e.field === "decision_needed" && e.reason === "decision_needed_field_rejected")) {
    throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
  }
});

await test("Drift 4: reply_to=main without authorized_by → block (CONTRACT)", () => {
  const params = makeValidV2Dispatch({ reply_to: "agent:main:main" });
  const errors = validateContractCompliance(params, {});
  if (errors.length === 0) throw new Error("expected block");
  if (!errors.some(e => e.reason === "reply_to_main_without_authorized_signal")) {
    throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
  }
});

await test("Drift 4 positive: reply_to=main WITH authorized_by → allow", () => {
  const params = makeValidV2Dispatch({
    reply_to: "agent:main:main",
    authorized_by: "kelsen-Phase-1-go-ahead-2026-08-19",
  });
  const errors = validateContractCompliance(params, {});
  if (errors.length > 0) throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
});

// Day 6a followup (Mavis 2026-08-22 09:53, user #8): Drift 6 — correlation_id chain integrity

await test("Drift 6: parent_dispatch_id set, correlation_id null → block (CONTRACT)", () => {
  const params = makeValidV2Dispatch({
    parent_dispatch_id: "d-parent-001",
    correlation_id: null,  // explicit null — auto-fill won't override
  });
  const errors = validateContractCompliance(params, {});
  const drift6 = errors.find(e => e.reason === "correlation_id_required_for_subtask");
  if (!drift6) throw new Error(`expected Drift 6 error, got: ${JSON.stringify(errors)}`);
  if (drift6.field !== "correlation_id") throw new Error(`wrong field: ${drift6.field}`);
});

await test("Drift 6 positive: parent_dispatch_id + correlation_id both set → allow", () => {
  const params = makeValidV2Dispatch({
    parent_dispatch_id: "d-parent-001",
    correlation_id: "thread-abc-001",
  });
  const errors = validateContractCompliance(params, {});
  const drift6 = errors.find(e => e.reason === "correlation_id_required_for_subtask");
  if (drift6) throw new Error(`unexpected Drift 6 error: ${JSON.stringify(drift6)}`);
});

await test("Drift 6: new task root (parent_dispatch_id=null) → Drift 6 not fired (auto-fill handles)", () => {
  const params = makeValidV2Dispatch({
    parent_dispatch_id: null,
    correlation_id: null,  // auto-fill will set this to dispatch_id in validateDispatchSchema Step 2.5
  });
  const errors = validateContractCompliance(params, {});
  const drift6 = errors.find(e => e.reason === "correlation_id_required_for_subtask");
  if (drift6) throw new Error(`Drift 6 should not fire for new task root, got: ${JSON.stringify(drift6)}`);
});

await test("Drift 5: source=phantom-agent impersonation → block (CONTRACT)", () => {
  const params = makeValidV2Dispatch({ source: "agent:ghost:main" });
  const errors = validateContractCompliance(params, { agentId: "coder" });
  if (errors.length === 0) throw new Error("expected block");
  if (!errors.some(e => e.field === "source" && e.reason === "source_impersonation_phantom_agent")) {
    throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
  }
});

await test("Drift 5 positive: source='coder' (registered agent) → allow", () => {
  const params = makeValidV2Dispatch({ source: "coder" });
  const errors = validateContractCompliance(params, { agentId: "coder" });
  if (errors.length > 0) throw new Error(`unexpected errors: ${JSON.stringify(errors)}`);
});

console.log("\n[Day 4 regression fixtures: Kelsen acCache lifecycle]");

import { createAcceptanceCriteriaCache as createAcCacheWithLifecycle } from "../src/ac-cache.js";

await test("Risk 1: cross-card AC bleed — same work session, different cardId, AC isolated", async () => {
  const acCacheL = createAcCacheWithLifecycle({ defaultTtlMs: 60_000 });
  const roleRegL = createSessionRoleRegistry();
  const guardL = createToolGuard(policy, roleRegL, undefined, acCacheL);

  // Day 6a followup (Mavis 2026-08-22 09:34): override sender to coder for same-agent
  // case (intra-agent sub-session spawn, allowed by HR1 cross-agent-to-work rule).
  // Bus dispatches card-X to work-A
  await guardL.beforeToolCall(
    makeDispatchEvent(makeValidV2Dispatch({
      card_id: "card-X",
      sender_session_key: "agent:coder:bus:dispatch-456",
      context_payload: { task_spec: "x", extracted_history: "y", acceptance_criteria: "ship X" },
    })),
    busCtx,
  );
  // Bus dispatches card-Y to same work session
  await guardL.beforeToolCall(
    makeDispatchEvent(makeValidV2Dispatch({
      card_id: "card-Y",
      sender_session_key: "agent:coder:bus:dispatch-456",
      target_session_key: "agent:coder:work:card-Y:primary:xyz",
      context_payload: { task_spec: "x", extracted_history: "y", acceptance_criteria: "ship Y" },
    })),
    busCtx,
  );

  // AC isolation: card-X cache has 'ship X', card-Y cache has 'ship Y', neither bleeds
  if (acCacheL.get("card-X") !== "ship X") throw new Error(`card-X AC wrong: ${acCacheL.get("card-X")}`);
  if (acCacheL.get("card-Y") !== "ship Y") throw new Error(`card-Y AC wrong: ${acCacheL.get("card-Y")}`);
});

await test("Risk 2: stale AC carry-over — TTL expiry → cache miss → fresh allowed (no false-positive block)", async () => {
  const acCacheL = createAcCacheWithLifecycle({ defaultTtlMs: 50 }); // 50ms TTL for test speed
  const roleRegL = createSessionRoleRegistry();
  const guardL = createToolGuard(policy, roleRegL, undefined, acCacheL);

  // Bus dispatches card with TTL 50ms
  await guardL.beforeToolCall(
    makeDispatchEvent(makeValidV2Dispatch({
      card_id: "card-stale",
      context_payload: { task_spec: "x", extracted_history: "y", acceptance_criteria: "old AC" },
    })),
    busCtx,
  );
  // Wait for TTL expiry
  await new Promise(resolve => setTimeout(resolve, 80));

  // Work session reports back with same AC after TTL — cache miss → fresh allowed (no false-positive block)
  roleRegL.set("agent:coder:work:card-stale:primary:xyz", {
    role: "work",
    parentSessionKey: "agent:kelsen:bus:webchat:test",
    agentId: "coder",
    cardId: "card-stale",
    subTaskId: "primary",
  });
  const workReportEvent = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-stale",
    sender_session_key: "agent:coder:work:card-stale:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "bus",
    context_payload: {
      task_spec: "x", extracted_history: "y", acceptance_criteria: "old AC",
    },
  }));
  const workReportCtx = { agentId: "coder", sessionKey: "agent:coder:work:card-stale:primary:xyz" };
  const result = await guardL.beforeToolCall(workReportEvent, workReportCtx);
  if (result && result.block === true) {
    throw new Error(`TTL-cleared AC should be allowed (not stale-blocked): ${result.blockReason}`);
  }
});

await test("acCache LRU cap: exceeding maxSize evicts oldest", () => {
  const cache = createAcCacheWithLifecycle({ maxSize: 3 });
  cache.set("card1", "AC1", { agentId: "a" });
  cache.set("card2", "AC2", { agentId: "a" });
  cache.set("card3", "AC3", { agentId: "a" });
  // 4th set evicts card1 (oldest by createdAt)
  cache.set("card4", "AC4", { agentId: "a" });
  if (cache.has("card1")) throw new Error("card1 should be evicted (LRU)");
  if (!cache.has("card4")) throw new Error("card4 should be present");
  if (cache.size !== 3) throw new Error(`size should be 3, got ${cache.size}`);
});

await test("acCache evictByAgent: cleans up on session_end pattern", () => {
  const cache = createAcCacheWithLifecycle();
  cache.set("c1", "AC1", { agentId: "kelsen" });
  cache.set("c2", "AC2", { agentId: "coder" });
  cache.set("c3", "AC3", { agentId: "kelsen" });
  const evicted = cache.evictByAgent("kelsen");
  if (evicted !== 2) throw new Error(`expected 2 evictions, got ${evicted}`);
  if (cache.has("c2") !== true) throw new Error("c2 should remain (agentId=coder)");
});

printSummary("Day 4");
process.exit(printSummary() > 0 ? 1 : 0);
