// peer-contract-enforcer contract compliance validator
// Day 4: enforces v1.1 §1.3 / §2 peer-to-peer metadata fields on dispatch payload.
//
// Per Kelsen 2026-08-19 contract_compliance_notes:
//   - Drift 1: source field — must equal sender agentId (v1.1 §1.3)
//   - Drift 2: reply_to field — required (v1.1 §2), cannot point at agent:*:main
//   - Drift 3: decision_needed field — new field, rejected until v0.1 §2.2 ratifies
//
// All three are checked against the dispatch payload top-level (alongside v0.1 §2.2
// schema fields). When Kelsen ratified v0.1, peer-to-peer metadata will move into
// a dedicated payload field (likely dispatch_extensions or peer_metadata); for now
// they live at payload top-level for backwards compat with v1.1 messages.

/**
 * @typedef {Object} ContractComplianceError
 * @property {"CONTRACT"} hr
 * @property {string} field
 * @property {string} reason
 * @property {string} message
 */

/**
 * Extract agentId from a sessionKey like "agent:kelsen:bus:webchat:test".
 * Returns the segment between "agent:" and the next ":".
 * @param {string} sessionKey
 * @returns {string | undefined}
 */
export function agentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return undefined;
  const m = sessionKey.match(/^agent:([^:]+):/);
  return m ? m[1] : undefined;
}

/**
 * Default valid agent whitelist. In production this should come from runtime agent registry
 * (OpenClaw configured agents). Tests inject their own whitelist via deps.validAgentIds.
 * Day 6a: prefer deps.agentRegistry (runtime registry from src/agent-registry.js) over hardcode.
 */
const DEFAULT_VALID_AGENT_IDS = new Set(["coder", "kelsen", "main"]);

/**
 * Validate dispatch payload against v1.1 contract metadata rules.
 * @param {Object} params — sessions_send event.params (or payload extracted from message)
 * @param {{ agentId?: string }} [ctx]
 * @param {{
 *   validAgentIds?: Set<string> | string[],
 *   agentRegistry?: { asWhitelist: () => Set<string> }
 * }} [deps] — optional runtime agent whitelist (Drift 5)
 * @returns {ContractComplianceError[]}
 */
export function validateContractCompliance(params, ctx, deps = {}) {
  /** @type {ContractComplianceError[]} */
  const errors = [];
  if (!params || typeof params !== "object") return errors;

  const ctxAgentId = ctx?.agentId;
  const senderSessionKey = params.sender_session_key;
  const senderAgentId = agentIdFromSessionKey(senderSessionKey);

  // Drift 5: source impersonation whitelist — priority:
  //   1. explicit deps.validAgentIds (test override)
  //   2. deps.agentRegistry.asWhitelist() (runtime registry from src/agent-registry.js)
  //   3. hardcode fallback ['coder', 'kelsen', 'main']
  let validAgentIds;
  if (deps.validAgentIds instanceof Set) {
    validAgentIds = deps.validAgentIds;
  } else if (Array.isArray(deps.validAgentIds)) {
    validAgentIds = new Set(deps.validAgentIds);
  } else if (deps.agentRegistry && typeof deps.agentRegistry.asWhitelist === "function") {
    validAgentIds = deps.agentRegistry.asWhitelist();
  } else {
    validAgentIds = DEFAULT_VALID_AGENT_IDS;
  }

  // Drift 3: decision_needed field — reject until v0.1 §2.2 ratifies.
  if ("decision_needed" in params) {
    errors.push({
      hr: "CONTRACT",
      field: "decision_needed",
      reason: "decision_needed_field_rejected",
      message: `field 'decision_needed' is not part of v0.1 §2.2 schema; rejected until ratification (use explicit phase1_audit / phase2_plan / decisions fields instead)`,
    });
  }

  // Drift 1: source reverse — if present, must equal sender agentId.
  if ("source" in params) {
    const sourceValue = params.source;
    if (sourceValue !== ctxAgentId && sourceValue !== senderAgentId) {
      errors.push({
        hr: "CONTRACT",
        field: "source",
        reason: "source_must_equal_sender_agent_id",
        message: `source field '${sourceValue}' must equal sender agentId ('${ctxAgentId ?? senderAgentId ?? "?"}'), per v1.1 §1.3`,
      });
    }

    // Drift 5: source impersonation — source value must be a registered agentId (no phantom agents).
    if (!validAgentIds.has(sourceValue)) {
      errors.push({
        hr: "CONTRACT",
        field: "source",
        reason: "source_impersonation_phantom_agent",
        message: `source field '${sourceValue}' does not match any registered runtime agent (whitelist: ${[...validAgentIds].join(",")}); phantom / unregistered agentIds rejected`,
      });
    }
  }

  // Drift 2: reply_to missing or pointing at agent:*:main.
  if (!("reply_to" in params)) {
    errors.push({
      hr: "CONTRACT",
      field: "reply_to",
      reason: "reply_to_missing",
      message: `reply_to field is required per v1.1 §2`,
    });
  } else {
    const replyTo = params.reply_to;
    if (typeof replyTo === "string" && /^agent:[^:]+:main$/.test(replyTo)) {
      // Drift 4: reply_to=main requires explicit authorized_by signal.
      // Without authorized_by, block (per v0.1 main-not-reply-target + v1.1 §2 restricted case).
      const hasAuthorizedBy = typeof params.authorized_by === "string" && params.authorized_by.length > 0;
      if (!hasAuthorizedBy) {
        errors.push({
          hr: "CONTRACT",
          field: "reply_to",
          reason: "reply_to_main_without_authorized_signal",
          message: `reply_to '${replyTo}' points at agent:*:main which requires explicit 'authorized_by' signal (e.g. prior dispatcher sessionKey or short message id referencing explicit go-ahead). v0.1 main-not-reply-target + v1.1 §2 restricted case.`,
        });
      }
    }
  }

  // Drift 6: correlation_id chain integrity (Day 6a followup, Mavis 2026-08-22 09:53, user #8).
  // Sub-tasks (parent_dispatch_id set) must carry the parent task's correlation_id.
  // New task roots (parent_dispatch_id=null) are auto-filled to dispatch_id by
  // validateDispatchSchema Step 2.5; sub-tasks with parent set must keep correlation_id.
  if (params.parent_dispatch_id && params.correlation_id == null) {
    errors.push({
      hr: "CONTRACT",
      field: "correlation_id",
      reason: "correlation_id_required_for_subtask",
      message: `parent_dispatch_id='${params.parent_dispatch_id}' is set but correlation_id is null; sub-tasks must carry the parent task's correlation_id (thread ID for chain tracking)`,
    });
  }

  return errors;
}

/**
 * Format ContractComplianceErrors into a single blockReason string.
 * @param {ContractComplianceError[]} errors
 * @returns {string}
 */
export function formatContractBlockReason(errors) {
  if (errors.length === 0) return "";
  return errors.map(e => `${e.hr}: ${e.field}: ${e.message} [${e.reason}]`).join(" | ");
}