// HR5.1 bus-context-required unit tests
// Day 8 (Mavis 2026-08-24, 老板 8/10 反馈): bus target session key MUST include
// a context-id segment. Bare `agent:<id>:bus` collapses to a shared inbox and
// reintroduces main-session-style cross-task contamination. See docs/bus-coordination.md.

import { test, reset, assertEq, assertOk, assertBlock, makeValidV2Dispatch } from "./_helpers.mjs";
import {
  validateBusContextRequired,
  validateDispatchSchema,
} from "../src/dispatch-schema.js";
import { createWorkbenchPolicy } from "../src/workbench-policy.js";

let total = 0;
function t(name, fn) { test(name, fn); total++; }

reset();

// ───────────────────── validateBusContextRequired direct ─────────────────────

console.log("\n# validateBusContextRequired (default policy: busContextRequired=true)");

t("rejects bare 'agent:<id>:bus' (no context)", () => {
  const errs = validateBusContextRequired("agent:coder:bus", "bus");
  assertEq(errs.length, 1);
  assertEq(errs[0].hr, "HR5");
  assertEq(errs[0].reason, "bus_context_required");
});

t("rejects 'agent:<id>:bus:' (trailing colon, empty context)", () => {
  const errs = validateBusContextRequired("agent:coder:bus:", "bus");
  assertEq(errs.length, 1);
  assertEq(errs[0].reason, "bus_context_required");
});

t("accepts 'agent:<id>:bus:dashboard' (single segment context)", () => {
  const errs = validateBusContextRequired("agent:coder:bus:dashboard", "bus");
  assertEq(errs.length, 0);
});

t("accepts 'agent:<id>:bus:webchat:user-123' (multi-segment context)", () => {
  const errs = validateBusContextRequired("agent:coder:bus:webchat:user-123", "bus");
  assertEq(errs.length, 0);
});

t("accepts 'agent:<id>:bus:dispatch-001' (kelsen-style)", () => {
  const errs = validateBusContextRequired("agent:kelsen:bus:dispatch-001", "bus");
  assertEq(errs.length, 0);
});

t("enforces on bus-shaped key regardless of target_role (legacy/CLI forms have no target_role)", () => {
  // Day 8 followup: HR5.1 is driven by session key SHAPE, not target_role.
  // v1.1 / legacy / CLI-via-agent dispatches may not populate target_role; relying on
  // target_role === "bus" would silently miss those. The key shape is authoritative.
  assertEq(validateBusContextRequired("agent:coder:bus", "work").length, 1);
  assertEq(validateBusContextRequired("agent:coder:bus", "main").length, 1);
  assertEq(validateBusContextRequired("agent:coder:bus", undefined).length, 1);
  assertEq(validateBusContextRequired("agent:coder:bus", "bus").length, 1);
});

t("does NOT enforce on empty target_session_key", () => {
  assertEq(validateBusContextRequired(undefined, "bus").length, 0);
  assertEq(validateBusContextRequired("", "bus").length, 0);
});

t("does NOT enforce on non-bus-shaped session keys (work/main/etc.)", () => {
  // work / main shape — leave to other validators
  assertEq(validateBusContextRequired("agent:coder:work:card:sub", "work").length, 0);
  assertEq(validateBusContextRequired("agent:coder:run:card:sub", "work").length, 0);
  assertEq(validateBusContextRequired("agent:coder:main", "main").length, 0);
  // Note: agent:coder:main is NOT a bus-shaped key, so HR5.1 doesn't fire even though
  // it's a bare main session key. main is allowed to be bare per spec §"main role".
});

// ───────────────────── explicit opt-out via busContextRequired=false ─────────────────────

console.log("\n# explicit opt-out: busContextRequired=false");

t("allows bare bus key when policy.busContextRequired=false", () => {
  const errs = validateBusContextRequired("agent:coder:bus", "bus", { busContextRequired: false });
  assertEq(errs.length, 0);
});

// ───────────────────── policy flag wiring ─────────────────────

console.log("\n# workbench policy busContextRequired wiring");

t("policy.busContextRequired defaults to true", () => {
  const p = createWorkbenchPolicy({});
  assertEq(p.busContextRequired, true);
});

t("policy.busContextRequired=false when explicitly set", () => {
  const p = createWorkbenchPolicy({ busContextRequired: false });
  assertEq(p.busContextRequired, false);
});

t("policy.busContextRequired=true when explicitly set", () => {
  const p = createWorkbenchPolicy({ busContextRequired: true });
  assertEq(p.busContextRequired, true);
});

// ───────────────────── integration with validateDispatchSchema ─────────────────────

console.log("\n# validateDispatchSchema integration");

const sessionRegistry = {
  validateSessionKey: (k) => {
    if (k === "agent:coder:bus:dashboard" || k === "agent:coder:bus:webchat:user-1" || k === "agent:coder:work:card-x:primary:y" || k === "agent:kelsen:bus:webchat:test") {
      return { valid: true, reason: "registered" };
    }
    return { valid: false, reason: "not registered" };
  },
};
const deps = {
  sessionRegistry,
  payloadSizeCapBytes: 65536,
  mainIntentsAllowlist: ["inform", "query", "sub-task", "response", "ack", "ping"],
  crossAgentToWorkBlocked: true,
  workSessionKeyPattern: /^agent:[^:]+:(work|run)(:.*)?$/,
  busSessionKeyPattern: /^agent:[^:]+:bus(:.*)?$/,
  busContextRequired: true,
};

t("validateDispatchSchema BLOCKS bare bus target with HR5.1 reason", () => {
  // pre-register so HR6 passes; HR5.1 should still block
  // We have to use a real registered key. Add one inline.
  const reg = {
    validateSessionKey: (k) => k === "agent:coder:bus" ? { valid: true, reason: "registered" } : { valid: false, reason: "no" },
  };
  const p = makeValidV2Dispatch({
    target_role: "bus",
    target_session_key: "agent:coder:bus",
    sender_role: "bus",
    sender_session_key: "agent:kelsen:bus:webchat:test",
  });
  const r = validateDispatchSchema(p, { sessionKey: "agent:kelsen:bus:webchat:test" }, {
    sessionRegistry: reg,
    payloadSizeCapBytes: 65536,
    mainIntentsAllowlist: deps.mainIntentsAllowlist,
    crossAgentToWorkBlocked: true,
    workSessionKeyPattern: deps.workSessionKeyPattern,
    busContextRequired: true,
  });
  if (r.ok) throw new Error("expected block, got ok");
  const hr5 = r.errors.find((e) => e.hr === "HR5" && e.reason === "bus_context_required");
  if (!hr5) throw new Error(`expected HR5.1 error, got: ${JSON.stringify(r.errors)}`);
});

t("validateDispatchSchema ALLOWS per-context bus target", () => {
  const p = makeValidV2Dispatch({
    target_role: "bus",
    target_session_key: "agent:coder:bus:dashboard",
    sender_role: "bus",
    sender_session_key: "agent:kelsen:bus:webchat:test",
  });
  const r = validateDispatchSchema(p, { sessionKey: "agent:kelsen:bus:webchat:test" }, deps);
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`);
});

t("validateDispatchSchema ALLOWS per-context bus target with multi-segment", () => {
  const reg = {
    validateSessionKey: (k) => k === "agent:coder:bus:webchat:user-1" ? { valid: true, reason: "registered" } : { valid: false, reason: "no" },
  };
  const p = makeValidV2Dispatch({
    target_role: "bus",
    target_session_key: "agent:coder:bus:webchat:user-1",
    sender_role: "bus",
    sender_session_key: "agent:kelsen:bus:webchat:test",
  });
  const r = validateDispatchSchema(p, { sessionKey: "agent:kelsen:bus:webchat:test" }, {
    ...deps,
    sessionRegistry: reg,
  });
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`);
});

t("validateDispatchSchema ALLOWS bare bus target when busContextRequired=false", () => {
  const reg = {
    validateSessionKey: (k) => k === "agent:coder:bus" ? { valid: true, reason: "registered" } : { valid: false, reason: "no" },
  };
  const p = makeValidV2Dispatch({
    target_role: "bus",
    target_session_key: "agent:coder:bus",
    sender_role: "bus",
    sender_session_key: "agent:kelsen:bus:webchat:test",
  });
  const r = validateDispatchSchema(p, { sessionKey: "agent:kelsen:bus:webchat:test" }, {
    ...deps,
    sessionRegistry: reg,
    busContextRequired: false,
  });
  if (!r.ok) throw new Error(`expected ok with opt-out, got: ${JSON.stringify(r.errors)}`);
});

t("validateDispatchSchema still ALLOWS non-bus targets (HR5.1 doesn't affect work/main)", () => {
  // Use same-agent dispatch to avoid HR1 cross-agent-to-work block (orthogonal concern).
  const reg = {
    validateSessionKey: (k) => k === "agent:coder:work:card-x:primary:y" ? { valid: true, reason: "registered" } : { valid: false, reason: "no" },
  };
  const p = makeValidV2Dispatch({
    target_role: "work",
    target_session_key: "agent:coder:work:card-x:primary:y",
    sender_role: "bus",
    sender_session_key: "agent:coder:bus:dashboard",
  });
  const r = validateDispatchSchema(p, { sessionKey: "agent:coder:bus:dashboard" }, {
    ...deps,
    sessionRegistry: reg,
  });
  if (!r.ok) throw new Error(`expected ok for work target, got: ${JSON.stringify(r.errors)}`);
});

console.log(`\n# total: ${total}`);
