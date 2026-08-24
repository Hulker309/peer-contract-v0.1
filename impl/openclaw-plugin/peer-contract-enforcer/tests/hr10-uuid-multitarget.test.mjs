// Day 8 v2 (2026-08-24, 老板 10:50 提示"结合 workboard"): HR10 task-dependency
// (schema-only — workboard card id UUID format) + HR5.1 multi-target bus context.
//
// Architectural note: peer-contract-enforcer is now schema-only for task
// dependency. Actual dependency-graph enforcement (waiting for parent in
// "done" status before child can dispatch) is the workboard plugin's
// responsibility, not this plugin's. Workboard has taskId field, linkCards
// API, and promoteReady private method that handles the state machine.

import { test, reset, assertEq, makeValidV2Dispatch } from "./_helpers.mjs";
import {
  validateTaskDependency,
  validateMultiTargetBusContext,
  validateDispatchSchema,
} from "../src/dispatch-schema.js";

let total = 0;
function t(name, fn) { test(name, fn); total++; }

reset();

// ───────────────────── validateTaskDependency (HR10) ─────────────────────

console.log("\n# validateTaskDependency (HR10 — schema-only, workboard is state source)");

t("no parent_task_id → no error (no dependency declared)", () => {
  const errs = validateTaskDependency(undefined);
  assertEq(errs.length, 0);
});

t("valid UUID v4 parent_task_id → no error", () => {
  // Example workboard card id format
  const errs = validateTaskDependency("7f4a2c10-3b5e-4f6a-8b9c-0d1e2f3a4b5c");
  assertEq(errs.length, 0);
});

t("valid UUID v1 parent_task_id → no error", () => {
  const errs = validateTaskDependency("550e8400-e29b-41d4-a716-446655440000");
  assertEq(errs.length, 0);
});

t("non-UUID string → BLOCK (parent_task_id_not_uuid)", () => {
  const errs = validateTaskDependency("task-42");
  assertEq(errs.length, 1);
  assertEq(errs[0].hr, "HR10");
  assertEq(errs[0].reason, "parent_task_id_not_uuid");
  assertEq(errs[0].message.includes("task-42"), true);
  assertEq(errs[0].message.includes("workboard"), true);
});

t("Kelsen-style task_id (task-123) → BLOCK", () => {
  // The most common pre-Day-8 error: caller uses human-readable task_id
  // instead of workboard card UUID. Should BLOCK with helpful message.
  const errs = validateTaskDependency("task-123");
  assertEq(errs.length, 1);
  assertEq(errs[0].reason, "parent_task_id_not_uuid");
});

t("empty string → BLOCK (parent_task_id_empty)", () => {
  const errs = validateTaskDependency("");
  assertEq(errs.length, 1);
  assertEq(errs[0].reason, "parent_task_id_empty");
});

t("non-string parent_task_id → BLOCK (parent_task_id_invalid_type)", () => {
  const errs = validateTaskDependency(12345);
  assertEq(errs.length, 1);
  assertEq(errs[0].reason, "parent_task_id_invalid_type");
});

t("non-string parent_task_id (null) → BLOCK", () => {
  const errs = validateTaskDependency(null);
  assertEq(errs.length, 1);
  assertEq(errs[0].reason, "parent_task_id_invalid_type");
});

t("uppercase UUID is accepted (UUIDs are case-insensitive per RFC 4122)", () => {
  const errs = validateTaskDependency("7F4A2C10-3B5E-4F6A-8B9C-0D1E2F3A4B5C");
  assertEq(errs.length, 0);
});

// ───────────────────── validateMultiTargetBusContext (HR5.1 multi) ─────────────────────

console.log("\n# validateMultiTargetBusContext (HR5.1 multi-target)");

t("empty array → no error", () => {
  const errs = validateMultiTargetBusContext([], {});
  assertEq(errs.length, 0);
});

t("undefined → no error (multi-target not used)", () => {
  const errs = validateMultiTargetBusContext(undefined, {});
  assertEq(errs.length, 0);
});

t("all per-context bus keys → ALLOW", () => {
  const errs = validateMultiTargetBusContext([
    "agent:image-artist:bus:webchat:user-boss",
    "agent:game-lead:bus:coordination",
    "agent:db-maintainer:bus:archive",
  ], {});
  assertEq(errs.length, 0);
});

t("any bare bus key in array → BLOCK that one", () => {
  const errs = validateMultiTargetBusContext([
    "agent:image-artist:bus:webchat:user-boss",
    "agent:game-lead:bus",  // bare — should BLOCK
    "agent:db-maintainer:bus:archive",
  ], {});
  assertEq(errs.length, 1);
  assertEq(errs[0].hr, "HR5");
  assertEq(errs[0].reason, "bus_context_required_multi");
  assertEq(errs[0].field, "target_session_keys[1]");
});

t("multiple bare bus keys → BLOCK each", () => {
  const errs = validateMultiTargetBusContext([
    "agent:game-lead:bus",
    "agent:db-maintainer:bus",
  ], {});
  assertEq(errs.length, 2);
  assertEq(errs[0].field, "target_session_keys[0]");
  assertEq(errs[1].field, "target_session_keys[1]");
});

t("non-string entry → BLOCK (multi_target_session_keys_invalid)", () => {
  const errs = validateMultiTargetBusContext([
    "agent:image-artist:bus:webchat:user-boss",
    42,
  ], {});
  assertEq(errs.length, 1);
  assertEq(errs[0].reason, "multi_target_session_keys_invalid");
});

t("non-bus keys in array → no HR5.1 multi error (leave to other validators)", () => {
  const errs = validateMultiTargetBusContext([
    "agent:modeler:work:task-X",
    "agent:main:main",
  ], {});
  assertEq(errs.length, 0);
});

t("busContextRequired: false opt-out → ALLOW bare bus keys", () => {
  const errs = validateMultiTargetBusContext([
    "agent:game-lead:bus",
    "agent:db-maintainer:bus",
  ], { busContextRequired: false });
  assertEq(errs.length, 0);
});

// ───────────────────── validateDispatchSchema integration ─────────────────────

console.log("\n# validateDispatchSchema integration: parent_task_id (UUID) + target_session_keys");

const sessionReg = {
  validateSessionKey: () => ({ valid: true, reason: "mock" }),
};
const baseDeps = {
  sessionRegistry: sessionReg,
  payloadSizeCapBytes: 65536,
  mainIntentsAllowlist: ["inform","query","sub-task","response","ack","ping"],
  crossAgentToWorkBlocked: true,
  workSessionKeyPattern: /^agent:[^:]+:(work|run)(:.*)?$/,
  busContextRequired: true,
  busSessionKeyPattern: /^agent:[^:]+:bus:.+$/,
};

t("payload.parent_task_id = valid UUID → no HR10 error", () => {
  const p = makeValidV2Dispatch({
    target_role: "work",
    target_session_key: "agent:coder:work:task-X:primary:y",
    sender_session_key: "agent:main:main",
    parent_task_id: "7f4a2c10-3b5e-4f6a-8b9c-0d1e2f3a4b5c",
  });
  const result = validateDispatchSchema(p, { sessionKey: "agent:main:main" }, baseDeps);
  const hr10 = result.errors.find((e) => e.hr === "HR10");
  if (hr10) throw new Error(`expected no HR10, got: ${JSON.stringify(result.errors)}`);
});

t("payload.parent_task_id = non-UUID → HR10 BLOCK with helpful message", () => {
  const p = makeValidV2Dispatch({
    target_role: "work",
    target_session_key: "agent:coder:work:task-X:primary:y",
    sender_session_key: "agent:main:main",
    parent_task_id: "task-123",  // NOT a UUID — common pre-Day-8 mistake
  });
  const result = validateDispatchSchema(p, { sessionKey: "agent:main:main" }, baseDeps);
  const hr10 = result.errors.find((e) => e.hr === "HR10" && e.reason === "parent_task_id_not_uuid");
  if (!hr10) throw new Error(`expected HR10 parent_task_id_not_uuid, got: ${JSON.stringify(result.errors)}`);
  if (!hr10.message.includes("workboard")) throw new Error(`expected helpful message mentioning workboard, got: ${hr10.message}`);
});

t("payload.bus.task_assignment.parent_task_id = valid UUID → ALLOW", () => {
  const p = makeValidV2Dispatch({
    target_role: "work",
    target_session_key: "agent:coder:work:task-Y:primary:z",
    sender_session_key: "agent:main:main",
    bus: {
      coordination_kind: "task_assignment",
      task_assignment: {
        task_id: "8e5dc307-d2b7-4afd-bd73-80f8ec5a77e6",
        parent_task_id: "7f4a2c10-3b5e-4f6a-8b9c-0d1e2f3a4b5c",
        assign_to: "agent:coder:work:task-Y:primary:z",
        expected_completion: "2026-08-25T00:00:00.000Z",
      },
    },
  });
  const result = validateDispatchSchema(p, { sessionKey: "agent:main:main" }, baseDeps);
  const hr10 = result.errors.find((e) => e.hr === "HR10");
  if (hr10) throw new Error(`expected no HR10, got: ${JSON.stringify(result.errors)}`);
});

t("payload.bus.task_assignment.parent_task_id = non-UUID → HR10 BLOCK", () => {
  const p = makeValidV2Dispatch({
    target_role: "work",
    target_session_key: "agent:coder:work:task-Y:primary:z",
    sender_session_key: "agent:main:main",
    bus: {
      coordination_kind: "task_assignment",
      task_assignment: {
        task_id: "any",
        parent_task_id: "task-123",  // NOT a UUID
        assign_to: "agent:coder:work:task-Y:primary:z",
        expected_completion: "2026-08-25T00:00:00.000Z",
      },
    },
  });
  const result = validateDispatchSchema(p, { sessionKey: "agent:main:main" }, baseDeps);
  const hr10 = result.errors.find((e) => e.hr === "HR10" && e.reason === "parent_task_id_not_uuid");
  if (!hr10) throw new Error(`expected HR10, got: ${JSON.stringify(result.errors)}`);
});

t("payload.target_session_keys array with bare bus in array → HR5 BLOCK", () => {
  const p = makeValidV2Dispatch({
    target_session_keys: [
      "agent:image-artist:bus:webchat:user-boss",
      "agent:game-lead:bus",  // bare
    ],
    sender_session_key: "agent:main:main",
  });
  const result = validateDispatchSchema(p, { sessionKey: "agent:main:main" }, baseDeps);
  const hr5 = result.errors.find((e) => e.hr === "HR5" && e.reason === "bus_context_required_multi");
  if (!hr5) throw new Error(`expected bus_context_required_multi, got: ${JSON.stringify(result.errors)}`);
  assertEq(hr5.field, "target_session_keys[1]");
});

t("payload.target_session_keys all per-context → no HR5 multi error", () => {
  const p = makeValidV2Dispatch({
    target_session_keys: [
      "agent:image-artist:bus:webchat:user-boss",
      "agent:game-lead:bus:coordination",
    ],
    sender_session_key: "agent:main:main",
  });
  const result = validateDispatchSchema(p, { sessionKey: "agent:main:main" }, baseDeps);
  const hr5 = result.errors.find((e) => e.hr === "HR5" && e.reason === "bus_context_required_multi");
  if (hr5) throw new Error(`expected no HR5 multi, got: ${JSON.stringify(result.errors)}`);
});

console.log(`\n# total: ${total}`);
