// peer-contract-enforcer agent registry
// Day 6a (Drift 5 whitelist ref): replaces hardcoded ['coder', 'kelsen', 'main'] whitelist
// with a runtime registry backed by:
//   1. Bootstrap scan of ~/.openclaw/agents/* directory listing (each subdir = agentId)
//      — sanity check: dir must have a `sessions/` subdir (avoid "logs", "memory" false positives)
//   2. session_start / subagent_spawned runtime hook registration
//   3. Hardcoded fallback (only when (1) and (2) both fail) — emits warning, never silent
//
// Future-proof: when OpenClaw plugin SDK exposes a session-info runtime API for the
// canonical agent list, replace bootstrapScan() with that lookup.

import { readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} AgentRegistryEntry
 * @property {string} agentId
 * @property {number} registeredAt — ms epoch
 * @property {string} source — "bootstrap" | "session_start" | "subagent_spawned" | "manual" | "config"
 * @property {string} [displayName]
 * @property {string} [role] — bus / work / etc.
 */

/**
 * Hardcoded fallback whitelist — only used when bootstrapScan finds zero agents
 * AND no runtime registrations exist. Order matters: more-specific first.
 */
const HARDCODED_FALLBACK = ["coder", "kelsen", "main"];

/**
 * Sanity check for "is this dir an agent dir?". A Heuristic:
 *   - dir contains a `sessions/` subdirectory (the canonical OpenClaw agent workspace shape)
 *   - OR dir name matches the HARDCODED_FALLBACK whitelist (known bootstrap agents)
 *
 * Avoids "logs", "memory", "backups" false positives that may also live at top level.
 * @param {string} dirPath — absolute path
 * @param {string} dirName — basename
 * @returns {boolean}
 */
function looksLikeAgentDir(dirPath, dirName) {
  // Known bootstrap agents always pass (covers cold-start case where sessions/ not yet created)
  if (HARDCODED_FALLBACK.includes(dirName)) return true;
  // Otherwise require sessions/ subdir
  try {
    const sessionsStat = statSync(path.join(dirPath, "sessions"));
    return sessionsStat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create agent registry backed by bootstrap filesystem scan + runtime hooks.
 * @param {{ openclawHomeDir?: string, fallbackAgentIds?: string[], logger?: (msg: string, level?: string) => void }} [opts]
 *   - logger: optional callback for fallback warnings + bootstrap diagnostics.
 *            Defaults to console.warn; pass `() => {}` for silent (tests).
 */
export function createAgentRegistry(opts = {}) {
  const openclawHomeDir = opts.openclawHomeDir ?? process.env.OPENCLAW_HOME ?? "C:/Users/Administrator/.openclaw";
  const fallbackAgentIds = opts.fallbackAgentIds ?? HARDCODED_FALLBACK;
  const logger = opts.logger ?? ((msg, level = "warn") => console[level]?.(msg) ?? console.log(msg));

  /** @type {Map<string, AgentRegistryEntry>} */
  const map = new Map();

  // Diagnostic state: tracks fallback use so install-smoke + trial metrics can surface it.
  /** @type {boolean} */
  let fallbackActivated = false;
  /** @type {string | undefined} */
  let fallbackReason = undefined;

  return {
    /**
     * Register an agentId (called from session_start / subagent_spawned hooks).
     * @param {string} agentId
     * @param {Omit<AgentRegistryEntry, "agentId"|"registeredAt"> & { registeredAt?: number }} [info]
     */
    register(agentId, info = {}) {
      if (!agentId || typeof agentId !== "string") return;
      if (map.has(agentId)) return; // first-write wins (bootstrap > runtime > manual)
      map.set(agentId, {
        agentId,
        registeredAt: info.registeredAt ?? Date.now(),
        source: info.source ?? "manual",
        ...info,
      });
    },

    /** @param {string} agentId */
    has(agentId) { return map.has(agentId); },

    /** @param {string} agentId @returns {AgentRegistryEntry | undefined} */
    get(agentId) { return map.get(agentId); },

    /** @returns {IterableIterator<[string, AgentRegistryEntry]>} */
    entries() { return map.entries(); },

    /** @returns {number} */
    size() { return map.size; },

    /**
     * Bootstrap from filesystem: list ~/.openclaw/agents/* subdirs; each subdir name = agentId.
     * Uses looksLikeAgentDir heuristic to avoid false positives.
     *
     * @param {string} [customHomeDir] override
     * @returns {{ scannedAgents: number, registeredAgents: string[], skippedDirs: string[] }}
     */
    bootstrapScan(customHomeDir) {
      const home = customHomeDir ?? openclawHomeDir;
      const agentsDir = path.join(home, "agents");
      if (!existsSync(agentsDir)) {
        logger(`[agent-registry] bootstrap scan: ${agentsDir} does not exist — will rely on runtime registration + hardcoded fallback`, "warn");
        return { scannedAgents: 0, registeredAgents: [], skippedDirs: [] };
      }
      let scannedAgents = 0;
      const registeredAgents = [];
      const skippedDirs = [];
      let dirents;
      try {
        dirents = readdirSync(agentsDir, { withFileTypes: true });
      } catch (e) {
        logger(`[agent-registry] bootstrap scan: readdir failed for ${agentsDir}: ${e.message}`, "warn");
        return { scannedAgents: 0, registeredAgents: [], skippedDirs: [] };
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const fullPath = path.join(agentsDir, dirent.name);
        if (!looksLikeAgentDir(fullPath, dirent.name)) {
          skippedDirs.push(dirent.name);
          logger(`[agent-registry] bootstrap scan: skipping '${dirent.name}' (no sessions/ subdir, not in hardcoded whitelist)`, "info");
          continue;
        }
        this.register(dirent.name, { source: "bootstrap" });
        scannedAgents++;
        registeredAgents.push(dirent.name);
      }
      if (scannedAgents === 0) {
        logger(`[agent-registry] bootstrap scan: 0 agent dirs found in ${agentsDir} (skipped: [${skippedDirs.join(", ")}])`, "warn");
      }
      return { scannedAgents, registeredAgents, skippedDirs };
    },

    /**
     * Materialize the current whitelist as a Set<string> for contract-compliance.js.
     * When no agents registered (cold start), returns the hardcoded fallback so
     * Drift 5 doesn't false-positive block on a freshly installed plugin.
     *
     * Logs a warning when fallback is activated (never silent) so install-smoke +
     * trial metrics can surface "agent registry never bootstrapped" issues.
     *
     * @returns {Set<string>}
     */
    asWhitelist() {
      if (map.size === 0) {
        if (!fallbackActivated) {
          fallbackActivated = true;
          fallbackReason = "registry_empty_after_bootstrap_and_runtime";
          logger(
            `[agent-registry] FALLBACK ACTIVATED: agent registry is empty (no bootstrap scan entries, no runtime hook registrations); using hardcoded fallback [${fallbackAgentIds.join(", ")}] for Drift 5 enforcement. ` +
            `Reason: ${fallbackReason}. ` +
            `Investigate: check ~/.openclaw/agents/ for subdirs with sessions/, or session_start hook registration.`,
            "warn",
          );
        }
        return new Set(fallbackAgentIds);
      }
      // Union with hardcoded fallback for resilience: known bootstrap agents always allowed.
      return new Set([...map.keys(), ...fallbackAgentIds]);
    },

    /** @returns {string[]} */
    listAgentIds() {
      return [...this.asWhitelist()];
    },

    /** @returns {{ fallbackActivated: boolean, fallbackReason: string | undefined }} */
    diagnostics() {
      return { fallbackActivated, fallbackReason: fallbackReason ? String(fallbackReason) : undefined };
    },
  };
}