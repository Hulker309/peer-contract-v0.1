// HR5: audit-cross-session-query unit tests (Day 5)
// Pure ESM .mjs, no TypeScript
// Run with: node tests/hr5-audit.test.mjs

import { createAuditLogger, normalizeEpochMs } from "../src/audit-logger.js";
import { createWorkbenchPolicy, createSessionRoleRegistry } from "../src/workbench-policy.js";
import { createAcceptanceCriteriaCache } from "../src/ac-cache.js";
import { createSessionRegistry } from "../src/session-registry.js";
import { createToolGuard } from "../src/tool-guard.js";
import { test, printSummary } from "./_helpers.mjs";

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
// Section: Audit logger unit tests (in-memory ring + file sink + workboard sink stub)
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n[HR5: audit logger unit]");

await test("record() appends event with timestamp", async () => {
  const audit = createAuditLogger({ disableFile: true });
  const event = await audit.record({
    kind: "cross_session_query",
    toolName: "sessions_history",
    agentId: "coder",
    sessionKey: "agent:coder:work:abc:primary:xyz",
  });
  if (typeof event.ts !== "number") throw new Error("ts should be number");
  if (event.kind !== "cross_session_query") throw new Error("kind mismatch");
  assertEq(audit.size, 1, "size after record");
  await audit.flush();
});

await test("entries() returns shallow copy", async () => {
  const audit = createAuditLogger({ disableFile: true });
  await audit.record({ kind: "k1", toolName: "t1", agentId: "a", sessionKey: "s" });
  await audit.record({ kind: "k2", toolName: "t2", agentId: "a", sessionKey: "s" });
  const e1 = audit.entries();
  if (e1.length !== 2) throw new Error("entries length wrong");
  e1.length = 0; // try mutating returned array
  if (audit.size !== 2) throw new Error("entries() should return copy, not reference");
});

await test("memory cap evicts oldest (LRU-style ring)", async () => {
  const audit = createAuditLogger({ disableFile: true, memoryCap: 3 });
  for (let i = 0; i < 5; i++) {
    await audit.record({ kind: `k${i}`, toolName: "t", agentId: "a", sessionKey: "s" });
  }
  const entries = audit.entries();
  if (entries.length !== 3) throw new Error(`ring size should be 3, got ${entries.length}`);
  if (entries[0].kind !== "k2") throw new Error(`oldest should be k2 (after evict k0, k1), got ${entries[0].kind}`);
});

await test("workboard sink receives event (async, errors swallowed)", async () => {
  const sinkCalls = [];
  const audit = createAuditLogger({
    disableFile: true,
    workboardSink: async (event) => { sinkCalls.push(event); },
  });
  await audit.record({ kind: "k1", toolName: "t", agentId: "a", sessionKey: "s" });
  await audit.flush();
  if (sinkCalls.length !== 1) throw new Error(`expected 1 sink call, got ${sinkCalls.length}`);
});

await test("workboard sink errors do not propagate to caller", async () => {
  const audit = createAuditLogger({
    disableFile: true,
    workboardSink: async () => { throw new Error("rpc fail"); },
  });
  // record should resolve cleanly even if sink throws
  await audit.record({ kind: "k1", toolName: "t", agentId: "a", sessionKey: "s" });
  await audit.flush();
  const lastError = audit._lastSinkError();
  if (!lastError || lastError.message !== "rpc fail") {
    throw new Error(`expected last sink error to be 'rpc fail', got ${lastError}`);
  }
});

await test("file sink appends to JSONL (best-effort, no throw on failure)", async () => {
  // Use a custom file path in a writable temp location.
  const path = "C:/Users/Administrator/.openclaw/agents/coder/.audit-test-tmp.jsonl";
  const audit = createAuditLogger({ filePath: path });
  await audit.record({ kind: "k1", toolName: "t", agentId: "a", sessionKey: "s" });
  await audit.record({ kind: "k2", toolName: "t", agentId: "a", sessionKey: "s" });
  await audit.flush();
  // Read back
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(path, "utf8");
  const lines = content.trim().split("\n");
  if (lines.length !== 2) throw new Error(`expected 2 lines, got ${lines.length}`);
  for (const line of lines) {
    const e = JSON.parse(line);
    if (e.kind !== "k1" && e.kind !== "k2") throw new Error("unexpected line");
  }
  // cleanup
  await fs.unlink(path).catch(() => {});
});

await test("resolveFilePath routes per event.agentId to per-agent JSONL (Day 6a followup)", async () => {
  // Day 6a followup (Mavis 2026-08-22 08:25): Kelsen report 8/22 8:17 flagged that
  // fixed filePath with `api?.config?.agentId ?? "coder"` always wrote to coder dir.
  // Fix: resolveFilePath takes precedence over filePath, computes per event.
  const fs = await import("node:fs/promises");
  const base = "C:/Users/Administrator/.openclaw/agents";
  const mainPath = `${base}/main/.audit-test-resolver.jsonl`;
  const coderPath = `${base}/coder/.audit-test-resolver.jsonl`;
  // Cleanup any prior test residue
  await fs.unlink(mainPath).catch(() => {});
  await fs.unlink(coderPath).catch(() => {});

  const audit = createAuditLogger({
    resolveFilePath: (event) => {
      const safe = String(event.agentId ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
      return `${base}/${safe}/.audit-test-resolver.jsonl`;
    },
  });
  await audit.record({ kind: "k1", toolName: "sessions_history", agentId: "main", sessionKey: "agent:main:dashboard:abc" });
  await audit.record({ kind: "k2", toolName: "sessions_history", agentId: "coder", sessionKey: "agent:coder:run:xyz" });
  await audit.record({ kind: "k3", toolName: "sessions_history", agentId: "main", sessionKey: "agent:main:dashboard:def" });
  await audit.flush();

  // mainPath should have 2 lines (k1, k3); coderPath should have 1 (k2)
  const mainContent = await fs.readFile(mainPath, "utf8");
  const coderContent = await fs.readFile(coderPath, "utf8");
  const mainLines = mainContent.trim().split("\n");
  const coderLines = coderContent.trim().split("\n");
  if (mainLines.length !== 2) throw new Error(`expected 2 lines in main, got ${mainLines.length}`);
  if (coderLines.length !== 1) throw new Error(`expected 1 line in coder, got ${coderLines.length}`);
  for (const line of mainLines) {
    const e = JSON.parse(line);
    if (e.agentId !== "main") throw new Error(`main file has non-main entry: ${e.agentId}`);
  }
  for (const line of coderLines) {
    const e = JSON.parse(line);
    if (e.agentId !== "coder") throw new Error(`coder file has non-coder entry: ${e.agentId}`);
  }
  // cleanup
  await fs.unlink(mainPath).catch(() => {});
  await fs.unlink(coderPath).catch(() => {});
});

await test("resolveFilePath takes precedence over filePath (mutually exclusive)", async () => {
  const fs = await import("node:fs/promises");
  const resolvedPath = "C:/Users/Administrator/.openclaw/agents/main/.audit-test-precedence.jsonl";
  const fixedPath = "C:/Users/Administrator/.openclaw/agents/coder/.audit-test-precedence.jsonl";
  await fs.unlink(resolvedPath).catch(() => {});
  await fs.unlink(fixedPath).catch(() => {});

  const audit = createAuditLogger({
    filePath: fixedPath,  // should be ignored
    resolveFilePath: () => resolvedPath,  // should win
  });
  await audit.record({ kind: "k", toolName: "t", agentId: "main", sessionKey: "s" });
  await audit.flush();
  // resolvedPath exists, fixedPath does not
  if (!(await fs.stat(resolvedPath).then(() => true).catch(() => false))) {
    throw new Error("resolveFilePath output was not written");
  }
  if (await fs.stat(fixedPath).then(() => true).catch(() => false)) {
    throw new Error("filePath was written despite resolveFilePath being set");
  }
  // cleanup
  await fs.unlink(resolvedPath).catch(() => {});
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: Audit integration via tool-guard (sessions_history + memory_search)
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n[HR5: tool-guard integration]");

const policy = createWorkbenchPolicy({});
const roleRegistry = createSessionRoleRegistry();
const sessionRegistry = createSessionRegistry({ openclawHomeDir: "C:/Users/Administrator/.openclaw" });
const acCache = createAcceptanceCriteriaCache();
const audit = createAuditLogger({ disableFile: true });
const guard = createToolGuard(policy, roleRegistry, sessionRegistry, acCache, audit);

await test("sessions_history tool call → audit log appended", async () => {
  audit.clear();
  const event = {
    toolName: "sessions_history",
    params: { sessionKey: "agent:coder:bus:dispatch-test", limit: 50 },
  };
  const ctx = { agentId: "coder", sessionKey: "agent:coder:work:abc:primary:xyz" };
  const result = await guard.beforeToolCall(event, ctx);
  assertOk(result, "sessions_history");
  await audit.flush();
  const entries = audit.entries();
  const crossSessionQuery = entries.find(e => e.kind === "cross_session_query");
  if (!crossSessionQuery) throw new Error("expected cross_session_query entry");
  if (crossSessionQuery.toolName !== "sessions_history") throw new Error("toolName mismatch");
  if (crossSessionQuery.targetSessionKey !== "agent:coder:bus:dispatch-test") throw new Error("targetSessionKey mismatch");
  if (crossSessionQuery.agentId !== "coder") throw new Error("agentId mismatch");
});

// Day 6a followup (Mavis 2026-08-22 10:25, Kelsen #8 feedback): correlation_id resolution
// from session-registry (chain tracking across audit log).

await test("sessions_history audit log gets correlationId from session-registry", async () => {
  audit.clear();
  // Simulate: session_start hook stored correlationId on the session.
  const sk = "agent:coder:work:card-8-test:primary:xyz-8";
  sessionRegistry.set(sk, {
    agentId: "coder",
    parentSessionKey: "agent:coder:bus:dispatch-8",
    correlationId: "thread-corr-id-001",
    source: "session_start",
  });
  const event = {
    toolName: "sessions_history",
    params: { sessionKey: "agent:other:bus:other", limit: 10 },
  };
  const ctx = { agentId: "coder", sessionKey: sk };
  const result = await guard.beforeToolCall(event, ctx);
  assertOk(result, "sessions_history with session-stored correlationId");
  await audit.flush();
  const entries = audit.entries();
  const e = entries.find(x => x.kind === "cross_session_query");
  if (!e) throw new Error("expected cross_session_query entry");
  if (e.correlationId !== "thread-corr-id-001") {
    throw new Error(`correlationId not resolved from session-registry: ${e.correlationId}`);
  }
});

await test("sessions_history audit log: explicit params.correlation_id wins over session-registry", async () => {
  audit.clear();
  const sk = "agent:coder:work:card-8-test2:primary:xyz-9";
  sessionRegistry.set(sk, {
    agentId: "coder",
    correlationId: "session-stored-thread",
    source: "session_start",
  });
  const event = {
    toolName: "sessions_history",
    params: {
      sessionKey: "agent:other:bus:other",
      limit: 10,
      correlation_id: "params-explicit-thread",
    },
  };
  const ctx = { agentId: "coder", sessionKey: sk };
  await guard.beforeToolCall(event, ctx);
  await audit.flush();
  const entries = audit.entries();
  const e = entries.find(x => x.kind === "cross_session_query");
  if (e.correlationId !== "params-explicit-thread") {
    throw new Error(`explicit params should win: got ${e.correlationId}`);
  }
});

await test("sessions_history audit log: no correlationId anywhere → undefined (not error)", async () => {
  audit.clear();
  const sk = "agent:coder:work:card-8-test3:primary:xyz-10";
  // No session-registry entry, no params.correlation_id, no ctx.correlationId
  const event = {
    toolName: "sessions_history",
    params: { sessionKey: "agent:other:bus:other", limit: 10 },
  };
  const ctx = { agentId: "coder", sessionKey: sk };
  await guard.beforeToolCall(event, ctx);
  await audit.flush();
  const entries = audit.entries();
  const e = entries.find(x => x.kind === "cross_session_query");
  if (e.correlationId !== undefined) {
    throw new Error(`correlationId should be undefined: got ${e.correlationId}`);
  }
});

await test("memory_search tool call → audit log appended with query", async () => {
  audit.clear();
  const event = {
    toolName: "memory_search",
    params: { query: "what did we decide about plugin enforcement?" },
  };
  const ctx = { agentId: "coder", sessionKey: "agent:coder:work:abc:primary:xyz" };
  const result = await guard.beforeToolCall(event, ctx);
  assertOk(result, "memory_search");
  await audit.flush();
  const entries = audit.entries();
  const entry = entries.find(e => e.toolName === "memory_search");
  if (!entry) throw new Error("expected memory_search entry");
  if (entry.query !== "what did we decide about plugin enforcement?") throw new Error("query mismatch");
});

await test("non-cross-session tool (read) does NOT add audit log", async () => {
  audit.clear();
  const event = { toolName: "read", params: { path: "/tmp/foo" } };
  const ctx = { agentId: "coder", sessionKey: "agent:coder:work:abc:primary:xyz" };
  await guard.beforeToolCall(event, ctx);
  await audit.flush();
  if (audit.size !== 0) throw new Error(`expected 0 audit entries, got ${audit.size}`);
});

await test("sessions_send with CONTRACT drift → audit not blocked, but guard returns block", async () => {
  audit.clear();
  // Pre-register the target work session so HR6 session-existence check passes,
  // allowing CONTRACT enforcement (Drift 5) to fire.
  sessionRegistry.set("agent:coder:work:abc:primary:xyz", {
    agentId: "coder", source: "session_start",
  });
  // sessions_send is not a cross-session query (it IS the session_send itself).
  // We use it to verify that CONTRACT enforcement (Day 4 fixture infra active) fires.
  // Note: Drift 5 (source impersonation) requires phantom-agent source; trigger Drift 1 instead.
  const event = {
    toolName: "sessions_send",
    params: {
      schema_version: "v2",
      protocol_version: "v2.0.0",
      dispatch_id: "d-test",
      parent_dispatch_id: null,
      original_dispatch_id: null,
      retry_count: 0,
      correlation_id: null,
      card_id: "card-x",
      parent_card_id: null,
      goal: "test",
      sender_role: "bus",
      // Day 6a followup (Mavis 2026-08-22 09:34): sender = coder bus (same agent) so HR1
      // cross-agent-to-work doesn't fire first. We want CONTRACT Drift 5 to fire here.
      sender_session_key: "agent:coder:bus:dispatch-456",
      target_role: "work",
      target_session_key: "agent:coder:work:abc:primary:xyz",
      context_payload: {
        task_spec: "x", extracted_history: "y", acceptance_criteria: "z",
      },
      payload_completeness: "self_contained",
      priority: "normal",
      max_runtime_minutes: 60,
      acceptance_policy: {
        ac_owner: "dispatcher_bus", ac_immutable_by_worker: true, verifier: "dispatcher_bus",
        retry_on_fail: "close_and_redispatch", max_retry_count: 1,
      },
      expected_reply_format: "v2",
      // Drift 5: phantom agent source
      source: "agent:phantom:main",
      reply_to: "agent:coder:bus:dispatch-prev",
      authorized_by: "test-fixture",
    },
  };
  // Day 6a followup: ctx.agentId = "coder" to match sender_session_key derivation.
  const ctx = { agentId: "coder", sessionKey: "agent:coder:bus:dispatch-456" };
  const result = await guard.beforeToolCall(event, ctx);
  assertBlock(result, /CONTRACT.*source.*phantom/, "Drift 5 in tool-guard");
  // sessions_send does NOT add cross_session_query entry (only sessions_history / memory_search do)
  await audit.flush();
  const crossQueries = audit.entries().filter(e => e.kind === "cross_session_query");
  if (crossQueries.length !== 0) throw new Error("sessions_send should not be a cross-session query audit entry");
});

await test("clear() empties the ring", async () => {
  await audit.record({ kind: "k1", toolName: "t", agentId: "a", sessionKey: "s" });
  if (audit.size !== 1) throw new Error("record should add 1");
  audit.clear();
  if (audit.size !== 0) throw new Error("clear should empty ring");
});

// Day 6a followup (Mavis 2026-08-22 09:53, user #8): correlationId in audit log

await test("record() includes correlationId in entry (chain tracking)", async () => {
  const a = createAuditLogger({ disableFile: true });
  await a.record({
    kind: "cross_session_query",
    toolName: "sessions_history",
    agentId: "kelsen",
    sessionKey: "agent:kelsen:bus:webchat:test",
    cardId: "card-abc",
    correlationId: "thread-xyz-001",
  });
  const entries = a.entries();
  if (entries.length !== 1) throw new Error(`expected 1 entry, got ${entries.length}`);
  if (entries[0].correlationId !== "thread-xyz-001") {
    throw new Error(`correlationId not preserved: ${entries[0].correlationId}`);
  }
});

await test("record() without correlationId leaves field undefined (no error)", async () => {
  const a = createAuditLogger({ disableFile: true });
  await a.record({
    kind: "cross_session_query",
    toolName: "sessions_history",
    agentId: "kelsen",
    sessionKey: "agent:kelsen:bus:webchat:test",
  });
  const entries = a.entries();
  if (entries.length !== 1) throw new Error(`expected 1 entry, got ${entries.length}`);
  if (entries[0].correlationId !== undefined) {
    throw new Error(`correlationId should be undefined when not set: ${entries[0].correlationId}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Section: HR5 hardening — ts normalization (workboard INTEGER NOT NULL contract)
// Defends against the 2026-08-19 incident where workboard_worker_logs.created_at
// was written as an ISO string, breaking workboard_list with
// "workboard sqlite row missing created_at".
// ──────────────────────────────────────────────────────────────────────────────

console.log("\n[HR5: ts normalization hardening]");

await test("normalizeEpochMs: number passes through", () => {
  const out = normalizeEpochMs(1787104229907, Date.now());
  if (out !== 1787104229907) throw new Error(`expected 1787104229907, got ${out}`);
});

await test("normalizeEpochMs: ISO string is coerced to epoch ms", () => {
  const out = normalizeEpochMs("2026-08-19T01:50:29.907Z", Date.now());
  if (out !== 1787104229907) throw new Error(`expected 1787104229907, got ${out}`);
});

await test("normalizeEpochMs: Date object is coerced to epoch ms", () => {
  const d = new Date("2026-08-19T01:50:29.907Z");
  const out = normalizeEpochMs(d, Date.now());
  if (out !== 1787104229907) throw new Error(`expected 1787104229907, got ${out}`);
});

await test("normalizeEpochMs: undefined / null / invalid → fallback", () => {
  const fallback = 12345;
  if (normalizeEpochMs(undefined, fallback) !== fallback) throw new Error("undefined not fallback");
  if (normalizeEpochMs(null, fallback) !== fallback) throw new Error("null not fallback");
  if (normalizeEpochMs("not a date", fallback) !== fallback) throw new Error("invalid string not fallback");
  if (normalizeEpochMs(NaN, fallback) !== fallback) throw new Error("NaN not fallback");
  if (normalizeEpochMs(Infinity, fallback) !== fallback) throw new Error("Infinity not fallback");
});

await test("record() normalizes caller-provided ts (string ISO \u2192 epoch ms INTEGER)", async () => {
  const audit2 = createAuditLogger({ disableFile: true });
  const event = await audit2.record({
    kind: "cross_session_query",
    toolName: "sessions_history",
    agentId: "coder",
    sessionKey: "agent:coder:work:test:primary:xyz",
    ts: "2026-08-19T01:50:29.907Z", // caller accidentally passes ISO string
  });
  if (typeof event.ts !== "number") throw new Error(`ts should be number, got ${typeof event.ts} (${event.ts})`);
  if (event.ts !== 1787104229907) throw new Error(`ts should be 1787104229907, got ${event.ts}`);
  await audit2.flush();
  // Sink must also receive epoch ms INTEGER (not string)
  const sinkSeen = [];
  const audit3 = createAuditLogger({ disableFile: true, workboardSink: async (e) => { sinkSeen.push(e); } });
  await audit3.record({ kind: "k", toolName: "t", agentId: "a", sessionKey: "s", ts: "2026-08-19T01:50:29.907Z" });
  await audit3.flush();
  if (sinkSeen.length !== 1) throw new Error(`expected 1 sink call, got ${sinkSeen.length}`);
  if (typeof sinkSeen[0].ts !== "number") throw new Error(`sink ts should be number, got ${sinkSeen[0].ts}`);
  if (sinkSeen[0].ts !== 1787104229907) throw new Error(`sink ts mismatch: ${sinkSeen[0].ts}`);
});

await test("record() without ts override uses Date.now() (epoch ms INTEGER)", async () => {
  const audit4 = createAuditLogger({ disableFile: true });
  const before = Date.now();
  const event = await audit4.record({ kind: "k", toolName: "t", agentId: "a", sessionKey: "s" });
  const after = Date.now();
  if (typeof event.ts !== "number") throw new Error(`ts should be number, got ${typeof event.ts}`);
  if (event.ts < before || event.ts > after) throw new Error(`ts ${event.ts} not in [${before}, ${after}]`);
  await audit4.flush();
});

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

printSummary("Day 5");
if (failed > 0) {
  process.exit(1);
}