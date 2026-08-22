// peer-contract-enforcer session role registry with hooks
// Implements HR2/HR3 role tracking for Day 3.
// Persistence (workboard card metadata) deferred to Day 6 to avoid SQL coupling.

/**
 * In-memory session role registry.
 * Hooks below populate this from subagent_spawned / session_start events.
 * Day 6 will add workboard card metadata persistence.
 */
export function createSessionRoleRegistry() {
  const map = new Map();
  return {
    set(sessionKey, info) {
      map.set(sessionKey, info);
    },
    get(sessionKey) {
      return map.get(sessionKey);
    },
    has(sessionKey) {
      return map.has(sessionKey);
    },
    delete(sessionKey) {
      map.delete(sessionKey);
    },
    entries() {
      return map.entries();
    },
    get size() {
      return map.size;
    },
    /** For tests / debugging */
    _memMap: map,
  };
}

/**
 * Handle subagent_spawned event: register child sessionKey as "work".
 * Child sessionKey pattern detection:
 * - v0.1: agent:<id>:work:<cardId>:<subTaskId>:<uuid>
 * - OpenClaw actual: agent:<id>:run:<cardId>
 */
export function createSubagentSpawnedHandler(roleRegistry) {
  return async (event) => {
    if (!event.childSessionKey) return;
    
    // Derive cardId / subTaskId from childSessionKey
    let cardId = null;
    let subTaskId = null;
    
    const v1Match = event.childSessionKey.match(/^agent:[^:]+:work:([^:]+):([^:]+):/);
    if (v1Match) {
      cardId = v1Match[1];
      subTaskId = v1Match[2];
    } else {
      const v2Match = event.childSessionKey.match(/^agent:[^:]+:run:([^:]+)/);
      if (v2Match) cardId = v2Match[1];
    }
    
    roleRegistry.set(event.childSessionKey, {
      role: "work",
      parentSessionKey: event.sessionKey,
      agentId: event.agentId,
      cardId,
      subTaskId,
    });
  };
}

/**
 * Handle session_start event: infer role from sessionKey pattern.
 * Day 6a+ followup (Mavis 2026-08-22 11:15, Kelsen P0-3 feedback): preserve parentSessionKey
 * set by subagent_spawned. OpenClaw fires subagent_spawned BEFORE session_start;
 * without this preserve, work sessions' parentSessionKey is always undefined and
 * HR2 parent check in tool-guard.js (callerInfo?.parentSessionKey && ...) short-circuits,
 * making HR2 dead code. The fix: read existing entry and inherit parentSessionKey.
 */
export function createSessionStartHandler(roleRegistry) {
  return async (event) => {
    if (!event.sessionKey) return;
    
    // Read existing entry (set by subagent_spawned). Inherit parentSessionKey +
    // subTaskId if present. This makes HR2 parent check work in tool-guard.
    const existing = roleRegistry.get(event.sessionKey);
    
    let role = "unknown";
    let cardId = existing?.cardId ?? null;
    let parentSessionKey = existing?.parentSessionKey;
    let subTaskId = existing?.subTaskId;
    let agentId = existing?.agentId ?? event.ctx?.agentId;
    
    if (/^agent:[^:]+:(work|run):/.test(event.sessionKey)) {
      role = "work";
      const m1 = event.sessionKey.match(/^agent:[^:]+:work:([^:]+):/);
      const m2 = event.sessionKey.match(/^agent:[^:]+:run:([^:]+)/);
      cardId = cardId ?? m1?.[1] ?? m2?.[1] ?? null;
    } else if (/^agent:[^:]+:bus:/.test(event.sessionKey)) {
      role = "bus";
    } else if (/^agent:[^:]+:main$/.test(event.sessionKey)) {
      role = "main";
    }
    
    if (role === "unknown") return; // don't pollute registry with unknowns
    
    roleRegistry.set(event.sessionKey, {
      role,
      parentSessionKey,  // inherited from subagent_spawned (or undefined for new sessions without parent)
      agentId,
      cardId,
      subTaskId,
      source: existing ? "session_start_inherit" : "session_start",
    });
  };
}

/**
 * Handle session_end event: remove from registry.
 */
export function createSessionEndHandler(roleRegistry) {
  return async (event) => {
    if (!event.sessionKey) return;
    roleRegistry.delete(event.sessionKey);
  };
}
