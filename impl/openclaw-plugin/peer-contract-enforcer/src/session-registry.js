// peer-contract-enforcer session registry
// Day 2: file-based + runtime sessionKey tracking for HR6 enforcement
// (Day 3 will add workboard card metadata persistence for restart survival)

import { readdirSync, statSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {Object} SessionRegistryEntry
 * @property {string} sessionKey
 * @property {string} [sessionId]      // uuid (for work sessions)
 * @property {string} [agentId]
 * @property {string} [parentSessionKey]
 * @property {string} [correlationId]  // Day 6a followup (Mavis 2026-08-22 09:53, user #8): propagated from dispatch, for chain tracking across audit log
 * @property {string} source          // "bootstrap" | "session_start" | "subagent_spawned" | "manual"
 * @property {number} registeredAt    // ms epoch
 */

/**
 * Create a session registry backed by in-memory map + filesystem bootstrap.
 * @param {{ openclawHomeDir?: string }} [opts]
 */
export function createSessionRegistry(opts = {}) {
  const openclawHomeDir = opts.openclawHomeDir ?? process.env.OPENCLAW_HOME ?? "C:/Users/Administrator/.openclaw";
  /** @type {Map<string, SessionRegistryEntry>} */
  const map = new Map();

  return {
    /** @param {string} sessionKey @param {Omit<SessionRegistryEntry, "sessionKey"|"registeredAt"> & { registeredAt?: number }} [info] */
    set(sessionKey, info = {}) {
      if (!sessionKey) return;
      map.set(sessionKey, {
        sessionKey,
        registeredAt: info.registeredAt ?? Date.now(),
        source: info.source ?? "manual",
        ...info,
      });
    },
    /** @param {string} sessionKey @returns {SessionRegistryEntry | undefined} */
    get(sessionKey) { return map.get(sessionKey); },
    /** @param {string} sessionKey */
    has(sessionKey) { return map.has(sessionKey); },
    /** @param {string} sessionKey */
    delete(sessionKey) { map.delete(sessionKey); },
    /** @returns {IterableIterator<[string, SessionRegistryEntry]>} */
    entries() { return map.entries(); },
    get size() { return map.size; },

    /**
     * Bootstrap from filesystem: scan all agents/<id>/sessions/*.jsonl,
     * extract sessionId, register as `agent:<agentId>:work:<cardId>:<subTaskId>:<sessionId>`.
     * Note: only work sessions can be confidently reverse-engineered from file paths.
     * Bus / main sessions are registered at runtime via session_start hook.
     *
     * @param {string} [customHomeDir] override openclawHomeDir for this scan
     * @returns {{ scannedAgents: number, registeredWorkSessions: number }}
     */
    async bootstrapScan(customHomeDir) {
      const home = customHomeDir ?? openclawHomeDir;
      const agentsDir = path.join(home, "agents");
      if (!existsSync(agentsDir)) {
        return { scannedAgents: 0, registeredWorkSessions: 0 };
      }

      let scannedAgents = 0;
      let registeredWorkSessions = 0;

      let agentDirs;
      try {
        agentDirs = readdirSync(agentsDir, { withFileTypes: true });
      } catch {
        return { scannedAgents: 0, registeredWorkSessions: 0 };
      }

      for (const dirent of agentDirs) {
        if (!dirent.isDirectory()) continue;
        const agentId = dirent.name;
        const sessionsDir = path.join(agentsDir, agentId, "sessions");
        if (!existsSync(sessionsDir)) continue;
        scannedAgents++;

        let files;
        try {
          files = readdirSync(sessionsDir);
        } catch {
          continue;
        }

        for (const file of files) {
          // Match: <uuid>.jsonl (not .deleted, not .trajectory, not .path)
          const m = file.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
          if (!m) continue;
          const sessionId = m[1];

          // The session uuid alone is not enough to reconstruct the full sessionKey
          // (we don't know cardId / subTaskId without metadata). Mark uuid-only as known
          // via the catch-all "agent:<id>:work:*:<sessionId>" pattern.
          // For practical HR6 enforcement, we accept any sessionKey whose last segment
          // matches a known sessionId (work session case).
          this.set(`agent:${agentId}:work:*:*:${sessionId}`, {
            sessionId,
            agentId,
            source: "bootstrap",
          });
          registeredWorkSessions++;
        }
      }

      return { scannedAgents, registeredWorkSessions };
    },

    /**
     * HR6 enforcement: validate a sessionKey exists.
     * Rules:
     * - main session (`agent:<id>:main`) → always valid (persistent)
     * - cron / dashboard / webchat root session keys → accepted (system sessions)
     * - explicit registry hit → valid
     * - pattern match (work sessionKey ends with known uuid) → valid
     * - otherwise → not valid
     *
     * @param {string} sessionKey
     * @returns {{ valid: boolean, reason: string, matchedVia?: string }}
     */
    validateSessionKey(sessionKey) {
      if (!sessionKey || typeof sessionKey !== "string") {
        return { valid: false, reason: "sessionKey missing or not a string" };
      }

      // 1. Main session always valid
      if (/^agent:[^:]+:main$/.test(sessionKey)) {
        return { valid: true, reason: "main session (persistent)", matchedVia: "pattern:main" };
      }

      // 2. Explicit registry hit (runtime-registered bus / work / subagent)
      if (map.has(sessionKey)) {
        const entry = map.get(sessionKey);
        return { valid: true, reason: `registered (source=${entry.source})`, matchedVia: `registry:${entry.source}` };
      }

      // 3. Work sessionKey pattern: agent:<id>:work:<cardId>:<subTaskId>:<uuid>
      //    If last segment matches a bootstrapped uuid, valid.
      const workMatch = sessionKey.match(/^agent:([^:]+):work:([^:]+):([^:]+):([^:]+)$/);
      if (workMatch) {
        const [, agentId, cardId, subTaskId, uuid] = workMatch;
        // Check wildcard-uuid pattern registered during bootstrap
        const wildcardKey = `agent:${agentId}:work:*:*:${uuid}`;
        if (map.has(wildcardKey)) {
          // Refine the registration with the actual sessionKey for future lookups
          this.set(sessionKey, {
            sessionId: uuid,
            agentId,
            parentSessionKey: null,
            cardId,
            subTaskId,
            source: "bootstrap",
          });
          return { valid: true, reason: "work session uuid matched filesystem", matchedVia: "bootstrap:work:uuid" };
        }
      }

      // 4. Bus sessionKey pattern: agent:<id>:bus:<dispatchId>
      //    Requires runtime registration (Day 3 will persist via workboard metadata).
      const busMatch = sessionKey.match(/^agent:[^:]+:bus:[^:]+$/);
      if (busMatch) {
        return { valid: false, reason: "bus session not registered at runtime (HR6 requires registration via session_start / subagent_spawned hook)" };
      }

      // 5. Cron run-scoped session: agent:<id>:cron:run:<runId> — accepted as system-originated
      if (/^agent:[^:]+:cron:run:[^:]+$/.test(sessionKey)) {
        return { valid: true, reason: "cron run session (system)", matchedVia: "pattern:cron-run" };
      }

      // 6. dashboard / webchat / tui — accepted as system root
      if (/^agent:[^:]+:(dashboard|webchat|tui):[^:]+$/.test(sessionKey)) {
        return { valid: true, reason: "system root session", matchedVia: "pattern:system-root" };
      }

      // 7. run-scoped session key (embedded runs)
      if (/^agent:[^:]+:run:[^:]+$/.test(sessionKey) || /^agent:[^:]+:[^:]+:run:[^:]+$/.test(sessionKey)) {
        return { valid: true, reason: "run-scoped session (system)", matchedVia: "pattern:run" };
      }

      return { valid: false, reason: `sessionKey '${sessionKey}' does not match any known pattern or registry entry` };
    },
  };
}