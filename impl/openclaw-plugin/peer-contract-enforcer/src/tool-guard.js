// peer-contract-enforcer tool guard
// Day 5 (final): all HR1-HR9 enforcement wired through tool-guard.
//   HR1 + HR6 + HR8 → dispatch-schema.js
//   HR4            → dispatch-validator.js
//   HR7            → ac-cache.js
//   HR2 + HR3 + HR9 → inline (preserved from Day 3)
//   HR5            → audit-logger (sessions_history / memory_search / message_sending)
//   CONTRACT       → contract-compliance.js (Drift 1-4 enforcement — P0 hard constraint from Kelsen)

import { inferRole } from "./workbench-policy.js";
import { WORKBENCH_ROLES } from "./types.js";
import { validateDispatchSchema, formatBlockReason } from "./dispatch-schema.js";
import { validatePayloadSelfContained } from "./dispatch-validator.js";
import { validateContractCompliance, formatContractBlockReason } from "./contract-compliance.js";

const ALLOW_ALL_SESSION_REGISTRY = { validateSessionKey: () => ({ valid: true, reason: "no registry, allow all" }) };

/**
 * @param {WorkbenchPolicy} policy
 * @param {SessionRoleRegistry} roleRegistry
 * @param {SessionRegistry} [sessionRegistry]
 * @param {AcceptanceCriteriaCache} [acCache]
 * @param {AuditLogger} [auditLogger]
 * @param {AgentRegistry} [agentRegistry] — Day 6a Drift 5 ref: contract-compliance uses this for source impersonation whitelist
 */
export function createToolGuard(policy, roleRegistry, sessionRegistry, acCache, auditLogger, agentRegistry) {
  return {
    /**
     * before_tool_call handler.
     * @param {ToolCallEvent} event
     * @param {ToolCallContext} ctx
     * @returns {Promise<BeforeToolCallResult | undefined>}
     */
    async beforeToolCall(event, ctx) {
      // ──────────── HR5: audit cross-session-query (Day 5) ────────────
      // sessions_history + memory_search are cross-session queries → audit log (non-blocking).
      if (auditLogger && (event.toolName === "sessions_history" || event.toolName === "memory_search")) {
        // Day 6a followup (Mavis 2026-08-22 10:25, Kelsen #8 feedback): correlation_id
        // resolution chain — params.correlation_id, ctx.correlationId, then session's
        // stored correlationId (from session_start hook). This is the fix for the
        // "audit log correlationId field not implemented" gap Kelsen reported.
        const sessionEntry = sessionRegistry?.get(ctx.sessionKey ?? "");
        const correlationId = (typeof event.params?.correlation_id === "string" ? event.params.correlation_id : undefined)
          ?? ctx.correlationId
          ?? sessionEntry?.correlationId;
        await auditLogger.record({
          kind: "cross_session_query",
          toolName: event.toolName,
          targetSessionKey: event.params?.sessionKey,
          query: typeof event.params?.query === "string" ? event.params.query : undefined,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          cardId: ctx.cardId,
          runId: ctx.runId,
          correlationId,
          meta: {
            paramKeys: Object.keys(event.params ?? {}),
          },
        });
      }

      // ──────────── Role inference ────────────
      const callerRole = roleRegistry.has(ctx.sessionKey ?? "")
        ? roleRegistry.get(ctx.sessionKey).role
        : inferRole(ctx.sessionKey, policy);
      const callerInfo = roleRegistry.has(ctx.sessionKey ?? "")
        ? roleRegistry.get(ctx.sessionKey)
        : null;

      // ──────────── HR9: work session tool restrictions ────────────
      if (callerRole === WORKBENCH_ROLES.WORK) {
        if (policy.workDeniedTools.has(event.toolName)) {
          return {
            block: true,
            blockReason: `HR9: work session cannot use tool '${event.toolName}' (workbench_policy denied)`,
          };
        }
      }

      // ──────────── HR1/HR6/HR8/HR4/HR7/CONTRACT/HR2/HR3: sessions_send ────────────
      if (event.toolName === "sessions_send") {
        const r = validateDispatchSchema(event.params, ctx, {
          sessionRegistry: sessionRegistry ?? ALLOW_ALL_SESSION_REGISTRY,
          payloadSizeCapBytes: policy.payloadSizeCapBytes,
          // Day 6a followup (Mavis 2026-08-22 09:34): pass intent-aware HR1 config
          mainIntentsAllowlist: policy.mainIntentsAllowlist,
          crossAgentToWorkBlocked: policy.crossAgentToWorkBlocked,
          workSessionKeyPattern: policy.workSessionKeyPattern,
        });
        if (!r.ok) {
          return {
            block: true,
            blockReason: formatBlockReason(r.errors),
          };
        }
        // After schema passes, derive target fields from resolved payload for downstream checks.
        const params = r.payload ?? event.params;
        const targetRole = params.target_role;
        const targetSessionKey = params.target_session_key ?? event.params.sessionKey;
        const contextPayload = params.context_payload;
        const cardId = params.card_id;

        // Day 6a followup (Mavis 2026-08-22 10:30, Kelsen #8 v2 feedback P0-1):
        // When sessions_send is called with `message=<JSON string>` (v2_message_string),
        // validateDispatchSchema parses the string into a NEW object, mutates it (auto-fill
        // correlation_id), but the mutation is on a copy that gets discarded. The OpenClaw
        // runtime delivers the ORIGINAL event.params.message string to the target session.
        // Write the mutated payload back to event.params.message so the target receives the
        // auto-filled values.
        if (r.resolvedShape === "v2_message_string" && typeof event.params.message === "string") {
          try {
            event.params.message = JSON.stringify(params);
          } catch (e) {
            // serialization should not throw (params is a plain object), but if it does,
            // leave the original message unchanged to avoid breaking the dispatch.
          }
        }

        // Day 6a followup (Mavis 2026-08-22 10:30, Kelsen #8 v2 feedback P0-2):
        // Pre-fill sessionRegistry with the target session's correlationId BEFORE
        // OpenClaw delivers the message. This way, when the target session's
        // session_start hook fires (or subsequent hooks like sessions_history /
        // message_sending), the session-registry already has the correlationId
        // for chain tracking. session_start's fallback chain will inherit this
        // when OpenClaw event doesn't propagate correlationId directly.
        if (targetSessionKey && params.correlation_id) {
          const existing = sessionRegistry?.get(targetSessionKey);
          sessionRegistry?.set(targetSessionKey, {
            ...(existing ?? {}),
            agentId: existing?.agentId ?? ctx.agentId,
            correlationId: params.correlation_id,
            source: existing?.source ?? "dispatch_prefill",
          });
        }

        // ──────────── CONTRACT (Day 4 fixture promoted to active Day 5) ────────────
        // Kelsen P0 hard constraint: 4 fixture must be active at Day 5/6 release.
        const contractErrors = validateContractCompliance(params, ctx, {
          agentRegistry, // Day 6a: Drift 5 impersonation whitelist from runtime registry
        });
        if (contractErrors.length > 0) {
          return {
            block: true,
            blockReason: formatContractBlockReason(contractErrors),
          };
        }

        // ──────────── HR4: payload-self-contained (Day 4) ────────────
        if (contextPayload) {
          const hr4 = validatePayloadSelfContained(contextPayload);
          if (!hr4.ok) {
            return {
              block: true,
              blockReason: `HR4: ${hr4.reason}`,
            };
          }
        }

        // ──────────── HR7: immutable-AC-by-worker (Day 4) ────────────
        if (acCache && cardId && contextPayload && typeof contextPayload.acceptance_criteria === "string") {
          const ac = contextPayload.acceptance_criteria;
          const ttlMs = (typeof params.max_runtime_minutes === "number" && params.max_runtime_minutes > 0)
            ? (params.max_runtime_minutes * 60_000) + 60_000
            : undefined;
          if (callerRole === WORKBENCH_ROLES.BUS) {
            acCache.set(cardId, ac, {
              ttlMs,
              setBy: ctx.sessionKey ?? ctx.agentId ?? "unknown-bus",
              agentId: ctx.agentId,
            });
          } else if (callerRole === WORKBENCH_ROLES.WORK) {
            const cachedAc = acCache.get(cardId);
            if (cachedAc !== undefined && cachedAc !== ac) {
              return {
                block: true,
                blockReason: `HR7: work session cannot modify acceptance_criteria (AC immutable by worker). Original: '${cachedAc}' (${cachedAc.length}B), modified: '${ac}' (${ac.length}B). Escalate to dispatcher.bus.`,
              };
            }
          }
        }

        // ──────────── HR3: no-user-to-work ────────────
        if (ctx.messageProvider && targetRole === "work") {
          return {
            block: true,
            blockReason: `HR3: channel-originated session ('${ctx.messageProvider}') cannot send to work sessions directly (no-user-to-work)`,
          };
        }

        // ──────────── HR2: no-cross-work-direct ────────────
        if (callerRole === WORKBENCH_ROLES.WORK) {
          if (targetRole !== "bus") {
            return {
              block: true,
              blockReason: `HR2/HR9: work session can only send to bus (target_role='bus'), got '${targetRole}'`,
            };
          }
          if (callerInfo?.parentSessionKey && callerInfo.parentSessionKey !== targetSessionKey) {
            return {
              block: true,
              blockReason: `HR2: work session can only send to its parent bus (${callerInfo.parentSessionKey}), got '${targetSessionKey}'`,
            };
          }
        }
        return undefined; // allow
      }

      // ──────────── HR8: payload-size-cap for non-sessions_send tools ────────────
      const size = JSON.stringify(event.params).length;
      if (size > policy.payloadSizeCapBytes) {
        return {
          block: true,
          blockReason: `HR8: payload size ${size}B exceeds cap ${policy.payloadSizeCapBytes}B`,
        };
      }

      return undefined; // allow
    },
  };
}