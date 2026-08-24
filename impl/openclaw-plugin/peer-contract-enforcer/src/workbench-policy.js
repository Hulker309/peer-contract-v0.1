// peer-contract-enforcer workbench policy + role inference
// Implements HR9 (work-toolset-restricted) per v0.1 review D6.

import { WORKBENCH_ROLES } from "./types.js";

/**
 * Default denied tools for work session per v0.1 review D6:
 * - message: cannot send to channels directly (bus's job)
 * - music_generate / image_generate / video_generate: not coder's job anyway
 * - skill_workshop: skill maintenance is bus decision, not work decision
 *
 * Day 6a followup (Mavis 2026-08-22 09:34): Kelsen report 8/22 9:06 Issue 2 — work
 * session needs to spawn sub-work for bus/work separation. Removed `sessions_spawn`
 * from deny list. Cross-agent abuse is caught by HR1 cross-agent-to-work block
 * (dispatch-schema.js validateNoDefaultToMain) which fires before the tool is invoked.
 */
const DEFAULT_WORK_DENIED_TOOLS = new Set([
  "message",
  "music_generate",
  "image_generate",
  "video_generate",
  "skill_workshop",
]);

/**
 * Create workbench policy from plugin config.
 *
 * Day 6a followup (Mavis 2026-08-22 09:34): added mainIntentsAllowlist + crossAgentToWorkBlocked
 * fields to support intent-aware HR1 + cross-agent-to-work block.
 *
 * @param {{payloadSizeCapBytes?: number, mainSessionKeyPattern?: string, workSessionKeyPattern?: string, busSessionKeyPattern?: string, mainIntentsAllowlist?: string[], crossAgentToWorkBlocked?: boolean}} config
 */
export function createWorkbenchPolicy(config) {
  return {
    workDeniedTools: new Set(DEFAULT_WORK_DENIED_TOOLS),
    workSessionSendWhitelist: new Set(),
    payloadSizeCapBytes: config.payloadSizeCapBytes ?? 65536,
    mainSessionKeyPattern: new RegExp(config.mainSessionKeyPattern ?? "^agent:[^:]+:main(:.*)?$"),
    // Day 6a+ followup (Mavis 2026-08-22 10:30, Kelsen #8 v2 feedback P1): default pattern
    // now accepts both "work:" and "run:" as work session prefixes. OpenClaw uses
    // "run:" for coder work sessions (e.g. agent:coder:run:<card>:<subTask>:<uuid>),
    // so the strict "work:" pattern missed the cross-agent-to-work check for these
    // sessions. role-registry.js already accepted both; this aligns the policy.
    workSessionKeyPattern: new RegExp(config.workSessionKeyPattern ?? "^agent:[^:]+:(work|run)(:.*)?$"),
    // bus dispatchId may contain ':' (e.g. "agent:kelsen:bus:webchat:test"), so allow it via .+
    // Day 8 (2026-08-24, 老板 8/10 反馈): default now requires at least one non-empty context-id
    // segment after `:bus:`. Bare `agent:<id>:bus` is no longer matched as a bus session; it falls
    // through to the "unknown" role (conservative allow, see inferRole below). HR5.1
    // (validateBusContextRequired) separately blocks bare bus *targets*. Both layers close the
    // "shared inbox" hole. Operators that intentionally want a shared-inbox bus must set an
    // explicit pattern via config.busSessionKeyPattern that accepts the bare form, AND set
    // busContextRequired=false.
    busSessionKeyPattern: new RegExp(config.busSessionKeyPattern ?? "^agent:[^:]+:bus:.+$"),
    // Day 8 followup (Mavis 2026-08-24, 老板 8/10 反馈): HR5.1 bus-context-required.
    // bus session key MUST include a context-id segment. Per-context bus is the
    // v0.1 spec coordination-layer design (see docs/bus-coordination.md); a bare
    // `agent:<id>:bus` collapses to a single shared inbox and reintroduces the
    // main-session-style cross-task contamination that bus was designed to avoid.
    // Default true. Operators that intentionally want a shared inbox must set
    // busContextRequired=false explicitly (with a comment why).
    busContextRequired: config.busContextRequired !== false, // default true
    // Day 6a followup: intent-aware HR1 + cross-agent-to-work block.
    mainIntentsAllowlist: Array.isArray(config.mainIntentsAllowlist)
      ? config.mainIntentsAllowlist
      : ["inform", "query", "sub-task", "response", "ack", "ping"],
    crossAgentToWorkBlocked: config.crossAgentToWorkBlocked !== false, // default true
  };
}

/**
 * Infer role from sessionKey pattern.
 * Returns "unknown" if pattern doesn't match → conservative allow (avoid false positive block).
 * @param {string | undefined} sessionKey
 * @param {WorkbenchPolicy} policy
 * @returns {WorkbenchRole}
 */
export function inferRole(sessionKey, policy) {
  if (!sessionKey) return WORKBENCH_ROLES.UNKNOWN;
  
  if (policy.workSessionKeyPattern.test(sessionKey)) return WORKBENCH_ROLES.WORK;
  if (policy.busSessionKeyPattern.test(sessionKey)) return WORKBENCH_ROLES.BUS;
  if (policy.mainSessionKeyPattern.test(sessionKey)) return WORKBENCH_ROLES.MAIN;
  
  return WORKBENCH_ROLES.UNKNOWN;
}

/**
 * In-memory session role registry (Day 1).
 * Day 3 will add workboard card metadata persistence for restart survival.
 * @returns {{
 *   set: (sessionKey: string, info: SessionRoleInfo) => void,
 *   get: (sessionKey: string) => SessionRoleInfo | undefined,
 *   has: (sessionKey: string) => boolean,
 *   delete: (sessionKey: string) => void,
 *   entries: () => IterableIterator<[string, SessionRoleInfo]>,
 *   size: number
 * }}
 */
export function createSessionRoleRegistry() {
  const map = new Map();
  return {
    set(sessionKey, info) { map.set(sessionKey, info); },
    get(sessionKey) { return map.get(sessionKey); },
    has(sessionKey) { return map.has(sessionKey); },
    delete(sessionKey) { map.delete(sessionKey); },
    entries() { return map.entries(); },
    get size() { return map.size; },
  };
}
