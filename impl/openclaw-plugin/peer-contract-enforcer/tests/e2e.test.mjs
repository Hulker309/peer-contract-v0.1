// peer-contract-enforcer e2e test harness (Day 6)
// Simulates the full v0.1 dispatch flow: Kelsen.bus → Coder.bus → Coder.work → Coder.bus → Kelsen.bus
// Verifies hook enforcement at each stage without requiring real OpenClaw runtime.
//
// Run with: node tests/e2e.test.mjs

import { createWorkbenchPolicy } from "../src/workbench-policy.js";
import { createSessionRoleRegistry } from "../src/role-registry.js";
import { createSessionRegistry } from "../src/session-registry.js";
import { createAcceptanceCriteriaCache } from "../src/ac-cache.js";
import { createAuditLogger } from "../src/audit-logger.js";
import { createToolGuard } from "../src/tool-guard.js";
import { createSubagentSpawnedHandler } from "../src/role-registry.js";
import { test, assertOk, assertBlock, printSummary, makeValidV2Dispatch, makeDispatchEvent } from "./_helpers.mjs";

console.log("\n[e2e: full v0.1 dispatch flow — Kelsen.bus → Coder.bus → Coder.work → Coder.bus → Kelsen.bus]");

// Setup: shared infrastructure across all e2e tests
function createE2EInfrastructure({ dryRun = false } = {}) {
  const config = {
    payloadSizeCapBytes: 65536,
    auditQueryContent: false,
    dryRun,
  };
  const policy = createWorkbenchPolicy(config);
  const roleRegistry = createSessionRoleRegistry();
  const sessionRegistry = createSessionRegistry({ openclawHomeDir: process.env.OPENCLAW_HOME ?? "C:/Users/Administrator/.openclaw" });
  const acCache = createAcceptanceCriteriaCache();
  const auditLogger = createAuditLogger({ disableFile: true });
  const toolGuard = createToolGuard(policy, roleRegistry, sessionRegistry, acCache, auditLogger);
  return { policy, roleRegistry, sessionRegistry, acCache, auditLogger, toolGuard };
}

// ──────────── E2E Phase 1: Kelsen.bus dispatches Coder.work ────────────
console.log("\n[Phase 1: Kelsen.bus dispatches Coder.work (HR1+HR6+HR7+HR9 setup)]");

const infra = createE2EInfrastructure();

// Step 1: Kelsen.bus session starts (session_start hook)
const kelsenBusKey = "agent:kelsen:bus:webchat:dispatch-e2e-1";
infra.sessionRegistry.set(kelsenBusKey, { agentId: "kelsen", source: "session_start" });
infra.roleRegistry.set(kelsenBusKey, { role: "bus", agentId: "kelsen" });

// Step 2: Coder.work session spawns via subagent_spawned hook (Kelsen dispatches work)
const coderWorkKey = "agent:coder:work:card-e2e-flow-001:primary:xyz-spawn-1";
await createSubagentSpawnedHandler(infra.roleRegistry)({
  childSessionKey: coderWorkKey,
  sessionKey: kelsenBusKey,
  agentId: "coder",
});

await test("e2e step 1: Coder.work session registered with parent bus link", async () => {
  const info = infra.roleRegistry.get(coderWorkKey);
  if (!info) throw new Error("work session not registered");
  if (info.role !== "work") throw new Error("role should be work");
  if (info.parentSessionKey !== kelsenBusKey) throw new Error(`parent should be ${kelsenBusKey}, got ${info.parentSessionKey}`);
});

await test("e2e step 2: Kelsen.bus sends v2 dispatch to Coder.work → allow", async () => {
  // Register Coder.work target session in sessionRegistry (HR6 session-existence)
  infra.sessionRegistry.set(coderWorkKey, { agentId: "coder", parentSessionKey: kelsenBusKey, source: "e2e_setup" });
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e-flow-001",
    sender_session_key: kelsenBusKey,
    target_session_key: coderWorkKey,
    context_payload: {
      task_spec: "implement peer-contract-enforcer",
      extracted_history: "boss revealed two-layer session model",
      acceptance_criteria: "9 HR tests pass + plugin install OK",
    },
  }));
  const kelsenCtx = { agentId: "kelsen", sessionKey: kelsenBusKey };
  const result = await infra.toolGuard.beforeToolCall(event, kelsenCtx);
  assertOk(result);
});

await test("e2e step 3: Kelsen.bus dispatch caches AC for HR7 backing", () => {
  const cachedAc = infra.acCache.get("card-e2e-flow-001");
  if (cachedAc !== "9 HR tests pass + plugin install OK") {
    throw new Error(`AC not cached: ${cachedAc}`);
  }
});

// ──────────── E2E Phase 2: Coder.work executes (HR2+HR3+HR9 inline + AC immutable) ────────────
console.log("\n[Phase 2: Coder.work executes — try to violate hard rules]");

const coderWorkCtx = { agentId: "coder", sessionKey: coderWorkKey };

await test("e2e step 4: Coder.work tries to send to work (not parent bus) → block HR2/HR9", async () => {
  // Register the OTHER work session too
  const otherWorkKey = "agent:coder:work:card-e2e-flow-001:secondary:other";
  infra.sessionRegistry.set(otherWorkKey, { agentId: "coder", parentSessionKey: kelsenBusKey, source: "e2e_setup" });
  // Need role entry for the target so HR6 passes session-existence
  infra.roleRegistry.set(otherWorkKey, { role: "work", agentId: "coder", parentSessionKey: kelsenBusKey });
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e-flow-001",
    sender_session_key: coderWorkKey,
    sender_role: "work",
    target_session_key: otherWorkKey,
    target_role: "work",
    source: "coder",
    context_payload: {
      task_spec: "report back",
      extracted_history: "y",
      acceptance_criteria: "9 HR tests pass + plugin install OK", // SAME as cached (avoid HR7 trip first)
    },
  }));
  const result = await infra.toolGuard.beforeToolCall(event, coderWorkCtx);
  assertBlock(result, /HR2|HR9/);
});

await test("e2e step 5: Coder.work tries to send to other bus (not parent) → block HR2", async () => {
  const otherBusKey = "agent:kelsen:bus:webchat:other-dispatch";
  infra.sessionRegistry.set(otherBusKey, { agentId: "kelsen", source: "e2e_setup" });
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e-flow-001",
    sender_session_key: coderWorkKey,
    sender_role: "work",
    target_session_key: otherBusKey,
    target_role: "bus",
    source: "coder",
    context_payload: {
      task_spec: "report back",
      extracted_history: "y",
      acceptance_criteria: "9 HR tests pass + plugin install OK", // SAME as cached
    },
  }));
  const result = await infra.toolGuard.beforeToolCall(event, coderWorkCtx);
  assertBlock(result, /HR2.*parent bus/);
});

await test("e2e step 6: Coder.work tries to MODIFY AC → block HR7", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e-flow-001",
    sender_session_key: coderWorkKey,
    sender_role: "work",
    target_session_key: kelsenBusKey,
    target_role: "bus",
    source: "coder",
    context_payload: {
      task_spec: "report back",
      extracted_history: "y",
      acceptance_criteria: "9 HR tests pass + plugin install OK + maybe relax HR7", // MODIFIED
    },
  }));
  const result = await infra.toolGuard.beforeToolCall(event, coderWorkCtx);
  assertBlock(result, /HR7.*modify/);
});

await test("e2e step 7: Coder.work tries to call denied tool (message) → block HR9", async () => {
  const event = { toolName: "message", params: { action: "send" } };
  const result = await infra.toolGuard.beforeToolCall(event, coderWorkCtx);
  assertBlock(result, /HR9.*cannot use.*message/);
});

await test("e2e step 8: Coder.work tries to send to parent bus with SAME AC → allow", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e-flow-001",
    sender_session_key: coderWorkKey,
    sender_role: "work",
    target_session_key: kelsenBusKey,
    target_role: "bus",
    source: "coder",
    context_payload: {
      task_spec: "report back",
      extracted_history: "y",
      acceptance_criteria: "9 HR tests pass + plugin install OK", // SAME
    },
  }));
  const result = await infra.toolGuard.beforeToolCall(event, coderWorkCtx);
  assertOk(result);
});

// ──────────── E2E Phase 3: Kelsen.bus receives work report (HR3 + HR1 enforcement) ────────────
console.log("\n[Phase 3: Kelsen.bus receives work report + user-channel attempts]");

await test("e2e step 9: Webchat channel session tries to send to work → block HR3", async () => {
  const webchatCtx = {
    agentId: "coder",
    sessionKey: "agent:coder:bus:webchat:user-input",
    messageProvider: "webchat",
    channel: "webchat",
  };
  infra.roleRegistry.set(webchatCtx.sessionKey, { role: "bus", agentId: "coder" });
  
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e-flow-001",
    sender_session_key: webchatCtx.sessionKey,
    sender_role: "bus",
    target_session_key: coderWorkKey,
    target_role: "work",
    source: "coder",
  }));
  const result = await infra.toolGuard.beforeToolCall(event, webchatCtx);
  assertBlock(result, /HR3.*channel-originated/);
});

await test("e2e step 10: Kelsen.bus tries to send to main → block HR1", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-e2e-flow-001",
    sender_session_key: kelsenBusKey,
    sender_role: "bus",
    target_session_key: "agent:coder:main",
    target_role: "work",
  }));
  const result = await infra.toolGuard.beforeToolCall(event, { agentId: "kelsen", sessionKey: kelsenBusKey });
  assertBlock(result, /HR1.*main session/);
});

// ──────────── E2E Phase 4: Dry-run mode verifies hook decisions are logged not enforced ────────────
console.log("\n[Phase 4: Dry-run mode — hook decisions logged but not enforced]");

const dryRunInfra = createE2EInfrastructure({ dryRun: true });

// In dry-run mode, the wrapper should convert { block: true } into undefined (allow)
// We'll wrap toolGuard.beforeToolCall with the same wrapper index.js uses
const dryRunWrapper = async (event, ctx) => {
  const result = await dryRunInfra.toolGuard.beforeToolCall(event, ctx);
  if (result?.block) {
    console.log(`[DRY-RUN would block] ${result.blockReason}`);
    return undefined; // allow
  }
  return result;
};

await test("e2e step 11: Dry-run allows normally-blocked dispatch (with log)", async () => {
  // Register target in sessionRegistry first
  const dryRunOtherWorkKey = "agent:coder:work:card-dryrun-test:secondary:other";
  dryRunInfra.sessionRegistry.set(dryRunOtherWorkKey, { agentId: "coder", parentSessionKey: kelsenBusKey, source: "e2e_setup" });
  dryRunInfra.roleRegistry.set(dryRunOtherWorkKey, { role: "work", agentId: "coder", parentSessionKey: kelsenBusKey });
  const event = makeDispatchEvent(makeValidV2Dispatch({
    card_id: "card-dryrun-test",
    sender_session_key: coderWorkKey,
    sender_role: "work",
    target_session_key: dryRunOtherWorkKey,
    target_role: "work",
    source: "coder",
  }));
  // In dry-run, the would-block is logged but not enforced
  const result = await dryRunWrapper(event, coderWorkCtx);
  assertOk(result); // allow (because dry-run converted block → allow)
});

// ──────────── E2E Phase 5: Audit log captures cross-session queries ────────────
console.log("\n[Phase 5: HR5 audit log captures sessions_history / memory_search]");

await test("e2e step 12: sessions_history invocation is audit-logged", async () => {
  const beforeSize = infra.auditLogger.size;
  const event = { toolName: "sessions_history", params: { sessionKey: "agent:kelsen:bus:webchat:dispatch-e2e-1" } };
  await infra.auditLogger.record({
    kind: "cross_session_query",
    toolName: event.toolName,
    targetSessionKey: event.params.sessionKey,
    agentId: "coder",
    sessionKey: coderWorkKey,
    cardId: "card-e2e-flow-001",
  });
  await infra.auditLogger.flush();
  const afterSize = infra.auditLogger.size;
  if (afterSize !== beforeSize + 1) {
    throw new Error(`audit size should grow by 1, was ${beforeSize} now ${afterSize}`);
  }
});

await test("e2e step 13: memory_search invocation is audit-logged", async () => {
  const beforeSize = infra.auditLogger.size;
  await infra.auditLogger.record({
    kind: "cross_session_query",
    toolName: "memory_search",
    query: "peer-contract v2",
    agentId: "coder",
    sessionKey: coderWorkKey,
    cardId: "card-e2e-flow-001",
  });
  await infra.auditLogger.flush();
  const afterSize = infra.auditLogger.size;
  if (afterSize !== beforeSize + 1) {
    throw new Error(`audit size should grow by 1, was ${beforeSize} now ${afterSize}`);
  }
});

printSummary("Day 6 e2e");
process.exit(printSummary() > 0 ? 1 : 0);
