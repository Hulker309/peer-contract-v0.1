// HR6 + 完整 HR1 unit tests (Day 2)
// Pure ESM .mjs, no TypeScript
// Run with: node tests/hr1-hr6.test.mjs

import { createWorkbenchPolicy, createSessionRoleRegistry } from "../src/workbench-policy.js";
import { createToolGuard } from "../src/tool-guard.js";
import { test, assertOk, assertBlock, printSummary, makeValidV2Dispatch, makeDispatchEvent } from "./_helpers.mjs";

const policy = createWorkbenchPolicy({});
const roleRegistry = createSessionRoleRegistry();
const guard = createToolGuard(policy, roleRegistry);

const busCtx = { agentId: "coder", sessionKey: "agent:coder:bus:dispatch-456" };
const workCtx = { agentId: "coder", sessionKey: "agent:coder:work:abc-123:primary:xyz-789" };

console.log("\n[HR6: required fields validation]");

const REQUIRED_FIELDS = [
  "schema_version", "protocol_version", "dispatch_id", "parent_dispatch_id",
  "original_dispatch_id", "retry_count", "correlation_id", "card_id",
  "parent_card_id", "goal", "sender_role", "sender_session_key",
  "target_role", "target_session_key", "context_payload",
  "payload_completeness", "priority", "max_runtime_minutes",
  "acceptance_policy", "expected_reply_format",
];

for (const field of REQUIRED_FIELDS) {
  await test(`missing '${field}' → block`, async () => {
    const payload = makeValidV2Dispatch();
    delete payload[field];
    const event = makeDispatchEvent(payload);
    const result = await guard.beforeToolCall(event, busCtx);
    // Accept either HR1 (extract payload fails) or HR6 (schema missing) reason
    assertBlock(result, new RegExp(`(HR1|HR6|CONTRACT)`));
  });
}

console.log("\n[HR6: context_payload required fields]");

const REQUIRED_CP_FIELDS = ["task_spec", "extracted_history", "acceptance_criteria"];
for (const field of REQUIRED_CP_FIELDS) {
  await test(`context_payload.${field} missing → block`, async () => {
    const payload = makeValidV2Dispatch();
    delete payload.context_payload[field];
    const event = makeDispatchEvent(payload);
    const result = await guard.beforeToolCall(event, busCtx);
    assertBlock(result, new RegExp(`HR6.*context_payload.*${field}`));
  });
}

console.log("\n[HR6: acceptance_policy required fields]");

const REQUIRED_AP_FIELDS = ["ac_owner", "ac_immutable_by_worker", "verifier", "retry_on_fail", "max_retry_count"];
for (const field of REQUIRED_AP_FIELDS) {
  await test(`acceptance_policy.${field} missing → block`, async () => {
    const payload = makeValidV2Dispatch();
    delete payload.acceptance_policy[field];
    const event = makeDispatchEvent(payload);
    const result = await guard.beforeToolCall(event, busCtx);
    assertBlock(result, new RegExp(`HR6.*acceptance_policy.*${field}`));
  });
}

console.log("\n[HR1/HR6: schema_version + role validation]");

await test("schema_version != 'v2' → block", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({ schema_version: "v1" }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR6/);
});

await test("sender_role = 'main' → block (Kelsen design: main not allowed as sender_role either)", async () => {
  // Per Kelsen validateSenderConsistency: ctx.sessionKey is authoritative; sender_role=main is invalid per V2_VALID_SENDER_ROLES
  const event = makeDispatchEvent(makeValidV2Dispatch({ sender_role: "main" }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR6.*sender_role/);
});

await test("target_role = 'main' → block", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({ target_role: "main" }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR6.*target_role/);
});

await test("priority = 'urgent' → allow (v0.1 review added urgent)", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({ priority: "urgent" }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("priority = 'invalid' → block", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({ priority: "invalid" }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR6.*priority/);
});

console.log("\n[HR1: target/sender session_key cannot be main]");

await test("target_session_key = main → block", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({ target_session_key: "agent:coder:main" }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertBlock(result, /HR1.*main session/);
});

// Per Kelsen validateSenderConsistency (Day 4 contract-compliance design):
// "v0.1 protocol allows sender_session_key to be the upstream dispatcher bus,
// which may differ from ctx.sessionKey when ctx is the downstream dispatch
// session. We don't enforce payload.sender_session_key === ctx.sessionKey;"
// So sender_session_key mismatch and sender=main are ALLOWED (sender_role=main is NOT, since V2_VALID_SENDER_ROLES rejects it).

console.log("\n[End-to-end: full valid dispatch flow]");

await test("bus → work valid dispatch → allow", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch());
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

await test("bus → bus valid dispatch → allow", async () => {
  const event = makeDispatchEvent(makeValidV2Dispatch({
    target_session_key: "agent:coder:bus:dispatch-789",
    target_role: "bus",
  }));
  const result = await guard.beforeToolCall(event, busCtx);
  assertOk(result);
});

printSummary("Day 2");
process.exit(printSummary() > 0 ? 1 : 0);
