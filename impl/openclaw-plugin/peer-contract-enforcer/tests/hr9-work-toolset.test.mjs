// HR9 + HR8 + HR1 unit tests (Day 1)
// Pure ESM .mjs, no TypeScript
// Run with: node tests/hr9-work-toolset.test.mjs

import { createWorkbenchPolicy, inferRole, createSessionRoleRegistry } from "../src/workbench-policy.js";
import { createToolGuard } from "../src/tool-guard.js";
import { test, assertEq, assertOk, assertBlock, printSummary, makeValidV2Dispatch, makeDispatchEvent } from "./_helpers.mjs";

const policy = createWorkbenchPolicy({});
const roleRegistry = createSessionRoleRegistry();
const guard = createToolGuard(policy, roleRegistry);

const workCtx = { agentId: "coder", sessionKey: "agent:coder:work:abc-123:primary:xyz-789" };
const busCtx = { agentId: "coder", sessionKey: "agent:coder:bus:dispatch-456" };
const mainCtx = { agentId: "coder", sessionKey: "agent:coder:main" };
const unknownCtx = { agentId: "coder", sessionKey: "some-random-key" };

console.log("\n[role inference tests]");

await test("work session pattern -> work role", () => {
  assertEq(inferRole("agent:coder:work:abc-123:primary:xyz-789", policy), "work");
});

await test("bus session pattern -> bus role", () => {
  assertEq(inferRole("agent:coder:bus:dispatch-456", policy), "bus");
});

await test("main session pattern -> main role", () => {
  assertEq(inferRole("agent:coder:main", policy), "main");
});

await test("unknown sessionKey -> unknown role", () => {
  assertEq(inferRole("some-random-key", policy), "unknown");
});

await test("undefined sessionKey -> unknown role", () => {
  assertEq(inferRole(undefined, policy), "unknown");
});

console.log("\n[HR9: work session denied tools]");

await test("work session blocked from message tool", async () => {
  const event = { toolName: "message", params: { action: "send" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR9.*cannot use.*message/);
});

await test("work session can use sessions_spawn (Day 6a followup: removed from HR9 deny list)", async () => {
  // Day 6a followup (Mavis 2026-08-22 09:34, Kelsen report 9:06 Issue 2): work session
  // can now spawn sub-work for bus/work separation. Cross-agent abuse is caught by
  // HR1 cross-agent-to-work block in dispatch-schema.js.
  const event = { toolName: "sessions_spawn", params: { task: "..." } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertOk(result);
});

await test("work session blocked from image_generate", async () => {
  const event = { toolName: "image_generate", params: { prompt: "..." } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR9.*cannot use.*image_generate/);
});

await test("work session blocked from music_generate", async () => {
  const event = { toolName: "music_generate", params: { prompt: "..." } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR9.*cannot use.*music_generate/);
});

await test("work session blocked from video_generate", async () => {
  const event = { toolName: "video_generate", params: { prompt: "..." } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR9.*cannot use.*video_generate/);
});

await test("work session blocked from skill_workshop", async () => {
  const event = { toolName: "skill_workshop", params: { action: "create" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR9.*cannot use.*skill_workshop/);
});

console.log("\n[HR9: work session allowed tools]");

await test("work session can use workboard_heartbeat", async () => {
  const event = { toolName: "workboard_heartbeat", params: { id: "abc" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertOk(result);
});

await test("work session can use workboard_complete", async () => {
  const event = { toolName: "workboard_complete", params: { id: "abc" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertOk(result);
});

await test("work session can use read", async () => {
  const event = { toolName: "read", params: { path: "/tmp/foo" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertOk(result);
});

await test("work session can use exec", async () => {
  const event = { toolName: "exec", params: { command: "ls" } };
  const result = await guard.beforeToolCall(event, workCtx);
  assertOk(result);
});

console.log("\n[HR9: bus / main / unknown sessions unrestricted]");

await test("bus session can use message", async () => {
  const event = { toolName: "message", params: { action: "send" } };
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("bus session can use sessions_spawn", async () => {
  const event = { toolName: "sessions_spawn", params: { task: "..." } };
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("main session can use message", async () => {
  const event = { toolName: "message", params: { action: "send" } };
  const result = await guard.beforeToolCall(event, mainCtx);
  assertOk(result);
});

await test("unknown session can use any tool (conservative)", async () => {
  const event = { toolName: "message", params: { action: "send" } };
  const result = await guard.beforeToolCall(event, unknownCtx);
  assertOk(result);
});

console.log("\n[HR8: payload size cap (64KB default)]");

await test("payload size > 64KB -> block (using read tool to avoid HR1)", async () => {
  const bigParams = { path: "/tmp/" + "x".repeat(70000) };
  const event = { toolName: "read", params: bigParams };
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR8.*payload size.*exceeds cap/);
});

await test("payload size = 60KB -> allow", async () => {
  const okParams = { path: "/tmp/" + "x".repeat(60000) };
  const event = { toolName: "read", params: okParams };
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("empty payload -> allow", async () => {
  const event = { toolName: "read", params: {} };
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

console.log("\n[HR1: no-default-to-main]");

await test("bus session sessions_send target=main -> block", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({ target_session_key: "agent:coder:main" }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR1.*main session/);
});

await test("work session sessions_send target=main -> block (HR1 + HR9)", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:work:abc:primary:xyz",
    sender_role: "work",
    target_session_key: "agent:coder:main",
    target_role: "bus",
  }));
  const result = await guard.beforeToolCall(event, workCtx);
  assertBlock(result, /HR1.*main/);
});

await test("sessions_send missing target -> block", async () => {
  const payload = makeValidV2Dispatch();
  delete payload.target_session_key;
  const event = makeDispatchEvent(payload);
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR1.*missing target_session_key/);
});

await test("sessions_send target=work same-agent (Day 6a followup: allowed for intra-agent sub-session spawn)", async () => {
  // Day 6a followup (Mavis 2026-08-22 09:34, Kelsen report 9:06 Issue 1 + user architectural
  // critique): same-agent work target is allowed (intra-agent sub-session spawn). Default
  // sender_session_key is kelsen, so override to coder to test same-agent case.
  const event = makeDispatchEvent(makeValidV2Dispatch({
    sender_session_key: "agent:coder:bus:dispatch-456",
    target_session_key: "agent:coder:work:abc:primary:xyz",
    target_role: "work",
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("sessions_send target=work cross-agent (Day 6a followup: blocked by HR1 cross-agent-to-work)", async () => {
  // Day 6a followup (Mavis 2026-08-22 09:34, user architectural critique): cross-agent
  // dispatch to work is an anti-pattern (bypasses target agent's coordination layer).
  // Default sender_session_key is kelsen, target is coder work — different agents → block.
  const event = makeDispatchEvent(makeValidV2Dispatch({
    target_session_key: "agent:coder:work:abc:primary:xyz",
    target_role: "work",
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR1.*cross_agent_to_work_forbidden/);
});

printSummary("Day 1");
process.exit(printSummary() > 0 ? 1 : 0);
