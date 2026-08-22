// Test helpers — shared between Day 1-5 tests
// Provides full v0.1 §2.2 dispatch schema + Day 5 v1.1 contract metadata fields.

export let passed = 0;
export let failed = 0;

export async function test(name, fn) {
  try {
    await fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`);
    failed++;
  }
}

export function reset() {
  passed = 0;
  failed = 0;
}

export function assertEq(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(`${msg} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

export function assertOk(result) {
  if (result && result.block === true) {
    throw new Error(`Expected allow but got block: ${result.blockReason}`);
  }
}

export function assertBlock(result, pattern) {
  if (!result || result.block !== true) {
    throw new Error(`Expected block but got allow: ${JSON.stringify(result)}`);
  }
  if (pattern && !pattern.test(result.blockReason)) {
    throw new Error(`Block reason mismatch: "${result.blockReason}" does not match ${pattern}`);
  }
}

/**
 * Extract agentId from a sessionKey like "agent:kelsen:bus:webchat:test".
 */
function agentIdFromSessionKey(sessionKey) {
  const m = sessionKey?.match?.(/^agent:([^:]+):/);
  return m ? m[1] : undefined;
}

/**
 * Full v0.1 §2.2 dispatch payload builder + Day 5 v1.1 contract metadata fields.
 * Provides ALL required fields so tests don't need to remember each one.
 * Pass `overrides` to mutate any field.
 *
 * Day 5 P0 (Kelsen): source auto-derived from sender_session_key so contract-compliance
 * passes by default. Override source to simulate Drift 1 (source reverse).
 * reply_to defaults to sender_session_key (non-main upstream). Override to point at
 * agent:main:main to simulate Drift 4 (reply_to=main without authorized_by).
 */
export function makeValidV2Dispatch(overrides = {}) {
  const base = {
    schema_version: "v2",
    protocol_version: "v2.0.0",
    dispatch_id: "d-" + Math.random().toString(36).slice(2),
    parent_dispatch_id: null,
    original_dispatch_id: null,
    retry_count: 0,
    correlation_id: null,
    card_id: "card-test",
    parent_card_id: null,
    goal: "test goal",
    sender_role: "bus",
    sender_session_key: "agent:kelsen:bus:webchat:test",
    target_role: "work",
    target_session_key: "agent:coder:work:card-test:primary:xyz",
    context_payload: {
      task_spec: "implement plugin enforcement",
      extracted_history: "boss revealed two-layer session model",
      acceptance_criteria: "9 HR tests pass",
    },
    payload_completeness: "self_contained",
    priority: "normal",
    max_runtime_minutes: 60,
    acceptance_policy: {
      ac_owner: "dispatcher_bus",
      ac_immutable_by_worker: true,
      verifier: "dispatcher_bus",
      retry_on_fail: "close_and_redispatch",
      max_retry_count: 1,
    },
    expected_reply_format: "peer-contract-v2-reply-v1",
  };

  const merged = { ...base, ...overrides };

  // Day 5 P0: source auto-derived from sender_session_key when caller doesn't override.
  if (!("source" in overrides)) {
    merged.source = agentIdFromSessionKey(merged.sender_session_key) ?? "kelsen";
  }
  // Day 5 P0: reply_to defaults to sender_session_key (non-main upstream); authorized_by provided.
  if (!("reply_to" in overrides)) {
    merged.reply_to = merged.sender_session_key ?? "agent:coder:bus:dispatch-prev";
    if (!("authorized_by" in overrides)) {
      merged.authorized_by = "Kelsen-Day-5-GO-2026-08-19-12:20";
    }
  }

  return merged;
}

/**
 * Wrap a dispatch payload into sessions_send event.
 */
export function makeDispatchEvent(payload, overrides = {}) {
  return {
    toolName: "sessions_send",
    params: payload,
    ...overrides,
  };
}

/**
 * Day 6a followup (Mavis 2026-08-22 09:34): make a valid v2 dispatch that is same-agent
 * (sender = coder bus, target = coder work). Use this for tests that exercise bus→work
 * dispatch as intra-agent sub-session spawn (HR1 cross-agent-to-work rule allows).
 * For cross-agent bus→work tests, use makeValidV2Dispatch with explicit overrides.
 */
export function makeSameAgentV2Dispatch(overrides = {}) {
  return makeValidV2Dispatch({
    sender_session_key: "agent:coder:bus:dispatch-456",
    target_session_key: "agent:coder:work:card-test:primary:xyz",
    ...overrides,
  });
}

/**
 * Make complete sessions_send event with full v0.1 schema.
 */
export function makeValidDispatchEvent(overrides = {}) {
  return makeDispatchEvent(makeValidV2Dispatch(overrides));
}

/**
 * Print test summary line.
 */
export function printSummary(label = "") {
  console.log("\n" + "=".repeat(40));
  console.log(`OK Passed: ${passed}`);
  console.log(`FAIL Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}${label ? "  (" + label + ")" : ""}`);
  return failed;
}