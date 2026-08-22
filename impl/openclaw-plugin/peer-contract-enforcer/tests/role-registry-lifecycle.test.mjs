// peer-contract-enforcer session role registry lifecycle test
// Day 6a+ followup (Mavis 2026-08-22 11:15, Kelsen P0-3 feedback): verify that
// session_start handler preserves parentSessionKey set by subagent_spawned handler.
// Without this, work session's callerInfo.parentSessionKey is undefined in tool-guard,
// HR2 parent check short-circuits, work→bus cross-agent ALLOWED (bug, violates
// 老板 10:40 design intent #2: "Coder 内部 bus/work 分离能达就行").

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRoleRegistry,
  createSubagentSpawnedHandler,
  createSessionStartHandler,
} from "../src/role-registry.js";

test("session_start preserves parentSessionKey set by subagent_spawned (P0-3 fix)", async () => {
  const registry = createSessionRoleRegistry();
  const subHandler = createSubagentSpawnedHandler(registry);
  const startHandler = createSessionStartHandler(registry);
  const childSk = "agent:coder:run:task-1:primary:abc-uuid";
  const parentSk = "agent:coder:bus:dispatch-parent";
  
  // Step 1: OpenClaw fires subagent_spawned — parentSessionKey is set.
  await subHandler({
    childSessionKey: childSk,
    sessionKey: parentSk,
    agentId: "coder",
  });
  let entry = registry.get(childSk);
  assert.equal(entry.parentSessionKey, parentSk, "subagent_spawned should set parentSessionKey");
  
  // Step 2: OpenClaw fires session_start — MUST preserve parentSessionKey (P0-3 fix).
  await startHandler({
    sessionKey: childSk,
    ctx: { agentId: "coder" },
  });
  entry = registry.get(childSk);
  assert.equal(entry.parentSessionKey, parentSk, "session_start must NOT overwrite parentSessionKey set by subagent_spawned");
  assert.equal(entry.role, "work");
  assert.equal(entry.agentId, "coder");
});

test("session_start for new session (no prior subagent_spawned) leaves parentSessionKey undefined", async () => {
  const registry = createSessionRoleRegistry();
  const startHandler = createSessionStartHandler(registry);
  const sk = "agent:coder:bus:dispatch-new";
  
  await startHandler({
    sessionKey: sk,
    ctx: { agentId: "coder" },
  });
  const entry = registry.get(sk);
  assert.equal(entry.role, "bus");
  assert.equal(entry.parentSessionKey, undefined, "no parent for new session without subagent_spawned");
});

test("session_start preserves subTaskId and cardId set by subagent_spawned", async () => {
  const registry = createSessionRoleRegistry();
  const subHandler = createSubagentSpawnedHandler(registry);
  const startHandler = createSessionStartHandler(registry);
  const childSk = "agent:coder:work:card-xyz:sub-1:uuid-abc";
  const parentSk = "agent:coder:bus:dispatcher";
  
  await subHandler({
    childSessionKey: childSk,
    sessionKey: parentSk,
    agentId: "coder",
  });
  await startHandler({
    sessionKey: childSk,
    ctx: { agentId: "coder" },
  });
  const entry = registry.get(childSk);
  assert.equal(entry.parentSessionKey, parentSk, "parent preserved");
  assert.equal(entry.cardId, "card-xyz", "cardId preserved from v1 pattern");
  assert.equal(entry.subTaskId, "sub-1", "subTaskId preserved from v1 pattern");
  assert.equal(entry.source, "session_start_inherit", "source marked as inherit when existing entry present");
});
