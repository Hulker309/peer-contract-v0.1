// HR2 + HR3 unit tests (Day 3)
// Pure ESM .mjs, no TypeScript
// Run with: node tests/hr2-hr3.test.mjs

import { createWorkbenchPolicy } from "../src/workbench-policy.js";
import { createSessionRoleRegistry, createSubagentSpawnedHandler, createSessionStartHandler, createSessionEndHandler } from "../src/role-registry.js";
import { createToolGuard } from "../src/tool-guard.js";
import { test, assertOk, assertBlock, printSummary, makeValidV2Dispatch, makeDispatchEvent } from "./_helpers.mjs";

const policy = createWorkbenchPolicy({});

console.log("\n[HR2: subagent_spawned populates role registry]");

await test("subagent_spawned with v0.1 work pattern registers as work", async () => {
  const roleRegistry = createSessionRoleRegistry();
  const handler = createSubagentSpawnedHandler(roleRegistry);
  
  await handler({
    childSessionKey: "agent:coder:work:card-abc:primary:xyz-789",
    sessionKey: "agent:coder:bus:dispatch-123",
    agentId: "coder",
  });
  
  const info = roleRegistry.get("agent:coder:work:card-abc:primary:xyz-789");
  if (!info) throw new Error("registry not populated");
  if (info.role !== "work") throw new Error(`expected work, got ${info.role}`);
  if (info.parentSessionKey !== "agent:coder:bus:dispatch-123") throw new Error("parent not set");
  if (info.cardId !== "card-abc") throw new Error(`cardId wrong: ${info.cardId}`);
  if (info.subTaskId !== "primary") throw new Error(`subTaskId wrong: ${info.subTaskId}`);
});

await test("subagent_spawned with OpenClaw actual run pattern registers as work", async () => {
  const roleRegistry = createSessionRoleRegistry();
  const handler = createSubagentSpawnedHandler(roleRegistry);
  
  await handler({
    childSessionKey: "agent:coder:run:card-abc",
    sessionKey: "agent:coder:bus:dispatch-123",
    agentId: "coder",
  });
  
  const info = roleRegistry.get("agent:coder:run:card-abc");
  if (!info) throw new Error("registry not populated");
  if (info.role !== "work") throw new Error(`expected work, got ${info.role}`);
  if (info.cardId !== "card-abc") throw new Error(`cardId wrong: ${info.cardId}`);
});

console.log("\n[HR2: session_start populates role registry]");

await test("session_start with work pattern registers as work", async () => {
  const roleRegistry = createSessionRoleRegistry();
  const handler = createSessionStartHandler(roleRegistry);
  
  await handler({
    sessionKey: "agent:coder:work:card-abc:primary:xyz-789",
    ctx: { agentId: "coder" },
  });
  
  const info = roleRegistry.get("agent:coder:work:card-abc:primary:xyz-789");
  if (!info) throw new Error("registry not populated");
  if (info.role !== "work") throw new Error(`expected work, got ${info.role}`);
});

await test("session_start with bus pattern registers as bus", async () => {
  const roleRegistry = createSessionRoleRegistry();
  const handler = createSessionStartHandler(roleRegistry);
  
  await handler({ sessionKey: "agent:coder:bus:dispatch-123", ctx: {} });
  
  const info = roleRegistry.get("agent:coder:bus:dispatch-123");
  if (!info) throw new Error("registry not populated");
  if (info.role !== "bus") throw new Error(`expected bus, got ${info.role}`);
});

await test("session_start with unknown pattern doesn't pollute registry", async () => {
  const roleRegistry = createSessionRoleRegistry();
  const handler = createSessionStartHandler(roleRegistry);
  
  await handler({ sessionKey: "some-random-key", ctx: {} });
  
  if (roleRegistry.has("some-random-key")) throw new Error("registry polluted");
});

console.log("\n[HR2: session_end cleans registry]");

await test("session_end removes from registry", async () => {
  const roleRegistry = createSessionRoleRegistry();
  const startHandler = createSessionStartHandler(roleRegistry);
  const endHandler = createSessionEndHandler(roleRegistry);
  
  await startHandler({ sessionKey: "agent:coder:work:card-abc:primary:xyz", ctx: {} });
  if (!roleRegistry.has("agent:coder:work:card-abc:primary:xyz")) throw new Error("not registered");
  
  await endHandler({ sessionKey: "agent:coder:work:card-abc:primary:xyz" });
  if (roleRegistry.has("agent:coder:work:card-abc:primary:xyz")) throw new Error("not cleaned");
});

console.log("\n[HR2: no-cross-work-direct]");

const roleRegistry2 = createSessionRoleRegistry();
await createSubagentSpawnedHandler(roleRegistry2)({
  childSessionKey: "agent:coder:work:card-abc:primary:xyz",
  sessionKey: "agent:coder:bus:parent-bus",
  agentId: "coder",
});

const workCtx = {
  agentId: "coder",
  sessionKey: "agent:coder:work:card-abc:primary:xyz",
};
const busCtx = {
  agentId: "coder",
  sessionKey: "agent:coder:bus:dispatch-other",
};
const guard = createToolGuard(policy, roleRegistry2);

await test("work session target=work (any) → block (HR2 + HR9)", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:work:card-abc:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:coder:work:card-abc:primary:other-work",
    target_role: "work",
  }));
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR2|HR9/);
});

await test("work session target=parent bus → allow", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:work:card-abc:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:coder:bus:parent-bus",
    target_role: "bus",
  }));
  const result = await guard.beforeToolCall(event, workCtx);
  assertOk(result);
});

await test("work session target=other bus → block (HR2 parent only)", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:work:card-abc:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:coder:bus:other-bus",
    target_role: "bus",
  }));
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR2.*parent bus/);
});

await test("bus session target=work → allow", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:kelsen:bus:webchat:dispatch",
    sender_role: "bus",
    target_session_key: "agent:coder:work:card-abc:primary:xyz",
    target_role: "work",
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

console.log("\n[HR3: no-user-to-work]");

await test("channel-originated session target=work → block (HR3)", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:bus:webchat:user",
    sender_role: "bus",
    source: "coder",
    target_session_key: "agent:coder:work:card:primary:xyz",
    target_role: "work",
  }));
  const channelCtx = {
    agentId: "coder",
    sessionKey: "agent:coder:bus:webchat:user",
    messageProvider: "webchat",
    channel: "webchat",
  };
  const result = await guard.beforeToolCall(event, channelCtx);
  assertBlock(result, /HR3.*channel-originated/);
});

await test("non-channel session target=work → allow (no HR3)", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:kelsen:bus:dispatch",
    sender_role: "bus",
    target_session_key: "agent:coder:work:card:primary:xyz",
    target_role: "work",
  }));
  const nonChannelCtx = {
    agentId: "kelsen",
    sessionKey: "agent:kelsen:bus:dispatch",
  };
  const result = await guard.beforeToolCall(event, nonChannelCtx);
  assertOk(result);
});

await test("channel-originated session target=bus → allow (HR3 only blocks work target)", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:bus:webchat:user",
    sender_role: "bus",
    source: "coder",
    target_session_key: "agent:coder:bus:other",
    target_role: "bus",
  }));
  const channelCtx = {
    agentId: "coder",
    sessionKey: "agent:coder:bus:webchat:user",
    messageProvider: "telegram",
  };
  const result = await guard.beforeToolCall(event, channelCtx);
  assertOk(result);
});

console.log("\n[End-to-end: HR2 + HR3 + role registry]");

await test("complete flow: subagent_spawned + work→parent bus → allow", async () => {
  const roleRegistry3 = createSessionRoleRegistry();
  await createSubagentSpawnedHandler(roleRegistry3)({
    childSessionKey: "agent:coder:work:card-flow:primary:xyz",
    sessionKey: "agent:kelsen:bus:webchat:dispatch-1",
    agentId: "coder",
  });
  
  const guard3 = createToolGuard(policy, roleRegistry3);
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:work:card-flow:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:kelsen:bus:webchat:dispatch-1",
    target_role: "bus",
  }));
  const ctx = {
    agentId: "coder",
    sessionKey: "agent:coder:work:card-flow:primary:xyz",
  };
  const result = await guard3.beforeToolCall(event, ctx);
  assertOk(result);
});

await test("complete flow: work→other bus → block HR2", async () => {
  const roleRegistry4 = createSessionRoleRegistry();
  await createSubagentSpawnedHandler(roleRegistry4)({
    childSessionKey: "agent:coder:work:card-flow2:primary:xyz",
    sessionKey: "agent:kelsen:bus:webchat:dispatch-2",
    agentId: "coder",
  });
  
  const guard4 = createToolGuard(policy, roleRegistry4);
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:work:card-flow2:primary:xyz",
    sender_role: "work",
    source: "coder",
    target_session_key: "agent:coder:bus:different-bus",
    target_role: "bus",
  }));
  const ctx = {
    agentId: "coder",
    sessionKey: "agent:coder:work:card-flow2:primary:xyz",
  };
  const result = await guard4.beforeToolCall(event, ctx);
  assertBlock(result, /HR2/);
});

printSummary("Day 3");
process.exit(printSummary() > 0 ? 1 : 0);
