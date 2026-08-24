// Day 8 HR5.1 runtime verification — exercises plugin dispatch-schema directly
// against the same payload the OpenClaw runtime would dispatch in cross-agent scenarios.
// Lives in plugin tests/ so it can use relative import without absolute path issues.

import { validateDispatchSchema } from "../src/dispatch-schema.js";

const baseCtx = { sessionKey: "agent:main:main" };
const baseDeps = {
  sessionRegistry: { validateSessionKey: () => ({ valid: true, reason: "mock" }) },
  payloadSizeCapBytes: 65536,
  mainIntentsAllowlist: ["inform","query","sub-task","response","ack","ping"],
  crossAgentToWorkBlocked: true,
  workSessionKeyPattern: /^agent:[^:]+:(work|run)(:.*)?$/,
  busContextRequired: true,
  busSessionKeyPattern: /^agent:[^:]+:bus:.+$/,
};

function makePayload(overrides) {
  return {
    schema_version: "v2",
    protocol_version: "v2.0.0",
    dispatch_id: "rt-" + Math.random().toString(36).slice(2),
    parent_dispatch_id: null,
    original_dispatch_id: null,
    retry_count: 0,
    correlation_id: null,
    card_id: "card-rt",
    parent_card_id: null,
    goal: "HR5.1 runtime verify",
    sender_role: "main",
    sender_session_key: "agent:main:main",
    target_role: "bus",
    target_session_key: "agent:game-lead:bus:dashboard",
    context_payload: { task_spec: "t", extracted_history: "h", acceptance_criteria: "a" },
    payload_completeness: "self_contained",
    priority: "normal",
    max_runtime_minutes: 60,
    acceptance_policy: { ac_owner: "d", ac_immutable_by_worker: true, verifier: "d", retry_on_fail: "c", max_retry_count: 1 },
    expected_reply_format: "v1",
    ...overrides,
  };
}

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("OK", name); } else { fail++; console.error("FAIL", name); } }

// 1. Per-context bus → ALLOW
{
  const r = validateDispatchSchema(makePayload({ target_session_key: "agent:game-lead:bus:dashboard" }), baseCtx, baseDeps);
  check("per-context bus ALLOW", r.ok);
  if (!r.ok) console.error("  errors:", r.errors);
}

// 2. Bare bus (Kelsen 8/24 form) → BLOCK HR5.1
{
  const r = validateDispatchSchema(makePayload({ target_session_key: "agent:game-lead:bus" }), baseCtx, baseDeps);
  check("bare bus BLOCK", !r.ok);
  const hr5 = r.errors.find((e) => e.hr === "HR5" && e.reason === "bus_context_required");
  check("bare bus has HR5.1 reason", !!hr5);
  if (hr5) console.log("  HR5.1 message:", hr5.message);
}

// 3. Multi-segment per-context bus → ALLOW
{
  const r = validateDispatchSchema(makePayload({ target_session_key: "agent:image-artist:bus:webchat:user-boss" }), baseCtx, baseDeps);
  check("multi-segment per-context bus ALLOW", r.ok);
  if (!r.ok) console.error("  errors:", r.errors);
}

// 4. Work target (HR5.1 doesn't affect) → ALLOW (use same-agent to avoid HR1 cross-agent-to-work block)
{
  const r = validateDispatchSchema(makePayload({
    target_role: "work",
    target_session_key: "agent:coder:work:card-x:primary:y",
    sender_session_key: "agent:coder:bus:dashboard",  // same agent (coder) as target
  }), { sessionKey: "agent:coder:bus:dashboard" }, baseDeps);
  check("work target ALLOW (HR5.1 doesn't fire)", r.ok);
  if (!r.ok) console.error("  errors:", r.errors);
}

// 5. Main target with task_assignment (HR1 BLOCK)
{
  const r = validateDispatchSchema(makePayload({
    target_role: "main",
    target_session_key: "agent:main:main",
  }), baseCtx, baseDeps);
  check("main target task_assignment (HR1 BLOCK)", !r.ok);
  const hr1 = r.errors.find((e) => e.hr === "HR1");
  check("main target HR1 reason", !!hr1);
}

// 6. Empty target_session_key → no error (HR5.1 doesn't fire on missing)
{
  const r = validateDispatchSchema(makePayload({ target_session_key: "" }), baseCtx, baseDeps);
  // Will fail other validation but not HR5.1
  const hr5 = r.errors.find((e) => e.hr === "HR5" && e.reason === "bus_context_required");
  check("empty target_session_key no HR5.1", !hr5);
}

console.log(`\n# pass: ${pass}  fail: ${fail}`);
if (fail > 0) process.exit(1);
