// peer-contract-enforcer plugin entry
// Path D (OpenClaw plugin hook) implementation per v0.1 review.
//
// Day 1: plugin skeleton + HR9 + HR8 + HR1 (basic)
// Day 2: HR6 schema validation + 完整 HR1 (full v0.1 §2.2 schema via dispatch-schema.js) + session-registry for HR6 session-existence
// Day 3: HR2 + HR3 + role registry via subagent_spawned / session_start hooks (role-registry.js)
// Day 4: HR4 payload-self-contained + HR7 AC immutable (ac-cache.js) + Drift 1-4 fixture infra (contract-compliance.js)
// Day 5: HR5 audit logger (audit-logger.js: in-memory ring + JSONL file + workboardSink stub) + contract-compliance P0 active + Drift 5 (phantom agent)
// Day 6a: Drift 5 whitelist ref (agent-registry.js) + e2e tests + README final + install-smoke
// Day 6a (Kelsen followup, halt 期间): runtime feed agentRegistry on session_start + subagent_spawned, with reserved-sessionKind blacklist;
//   fallback activation emits warning (never silent); bootstrap sanity check skips non-agent dirs.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createWorkbenchPolicy } from "./workbench-policy.js";
import { createSessionRoleRegistry, createSubagentSpawnedHandler, createSessionStartHandler, createSessionEndHandler } from "./role-registry.js";
import { createSessionRegistry } from "./session-registry.js";
import { createAgentRegistry } from "./agent-registry.js";
import { createAcceptanceCriteriaCache } from "./ac-cache.js";
import { createAuditLogger } from "./audit-logger.js";
import { createToolGuard } from "./tool-guard.js";

/**
 * OpenClaw sessionKey segment blacklists — these are session *kinds*, not agentIds.
 * When a session_start event reports ctx.agentId that is actually a sessionKind segment
 * (e.g. "webchat", "subagent", "dashboard"), we must NOT register it as an agentId in
 * agent-registry — otherwise Drift 5 impersonation whitelist would drift.
 * (Kelsen 2026-08-19 Drift 5 ref review hold #1.)
 */
const RESERVED_SESSION_KINDS = new Set([
  "webchat", "subagent", "dashboard", "tui", "run",
  "work", "bus", "main", "cron", "qqbot", "discord", "telegram",
  "matrix", "mattermost", "nextcloud-talk", "synology-chat", "zalo",
  "imessage", "irc", "twitch", "slack", "signal", "feishu", "line",
  "whatsapp", "nostr", "googlechat", "msteams", "raft", "sms",
  "clickclack", "zalouser", "alime",
]);

export default definePluginEntry({
  id: "peer-contract-enforcer",
  name: "Peer Contract Enforcer",
  description: "Enforces peer-contract v2 hard rules 1-9 via OpenClaw plugin hooks (path D). See agents/coder/docs/hook-enforcement-investigation-2026-08-19.md for design.",

  // Synchronous register() — OpenClaw 0.7.1-2 strict-sync guard rejects async register.
  // Day 6 emergency fix (Mavis 2026-08-22 07:24): was `async register`, gateway 7:21 fresh
  // start aborted with "plugin register must be synchronous". Bootstrap scans are now
  // fire-and-forget so they can complete asynchronously without blocking register.
  register(api) {
    const config = (api.config ?? {});

    const policy = createWorkbenchPolicy(config);
    const roleRegistry = createSessionRoleRegistry();
    const sessionRegistry = createSessionRegistry({
      openclawHomeDir: process.env.OPENCLAW_HOME ?? "C:/Users/Administrator/.openclaw",
    });
    const agentRegistry = createAgentRegistry({
      openclawHomeDir: process.env.OPENCLAW_HOME ?? "C:/Users/Administrator/.openclaw",
      logger: (msg, level) => {
        // Surface warning/error to OpenClaw plugin logger.
        if (level === "warn") api.logger?.warn?.(msg);
        else api.logger?.info?.(msg);
      },
    });
    const acCache = createAcceptanceCriteriaCache();
    const auditLogger = createAuditLogger({
      filePath: `${process.env.OPENCLAW_HOME ?? "C:/Users/Administrator/.openclaw"}/agents/${api?.config?.agentId ?? "coder"}/peer-contract-enforcer-audit.jsonl`,
    });

    // Bootstrap session registry from existing work session files (HR6 session-existence).
    // Fire-and-forget: scan is async (file IO), but register must return synchronously.
    sessionRegistry.bootstrapScan()
      .then((scan) => {
        api.logger?.info?.(`peer-contract-enforcer: bootstrapped ${scan.registeredWorkSessions} work sessions from ${scan.scannedAgents} agents`);
      })
      .catch((e) => {
        api.logger?.warn?.(`peer-contract-enforcer: session bootstrap scan failed: ${e.message}`);
      });

    // Bootstrap agent registry from ~/.openclaw/agents/* directory listing (Day 6a Drift 5 ref).
    // bootstrapScan() is sync — call inline.
    try {
      const agentScan = agentRegistry.bootstrapScan();
      api.logger?.info?.(`peer-contract-enforcer: agent registry bootstrapped ${agentScan.scannedAgents} agents (whitelist: ${agentRegistry.listAgentIds().join(",")}; skipped: [${agentScan.skippedDirs?.join(",") ?? ""}])`);
      const diag = agentRegistry.diagnostics();
      if (diag.fallbackActivated) {
        api.logger?.warn?.(`peer-contract-enforcer: agent registry FALLBACK active — reason: ${diag.fallbackReason}. Drift 5 enforcement will use hardcoded whitelist.`);
      }
    } catch (e) {
      api.logger?.warn?.(`peer-contract-enforcer: agent registry bootstrap failed: ${e.message}`);
    }

    const toolGuard = createToolGuard(policy, roleRegistry, sessionRegistry, acCache, auditLogger, agentRegistry);

    // ──────────── Day 6: dry-run wrapper ────────────
    // When config.dryRun === true, hook decisions are logged but never actually block.
    // Use for review / shadow-mode rollout (verify hook decisions without breaking live flow).
    const dryRun = config.dryRun === true;
    if (dryRun) {
      api.logger?.info?.(`[peer-contract-enforcer] DRY-RUN mode enabled — hook decisions will be logged but NOT enforced`);
    }
    const guardedBeforeToolCall = dryRun
      ? async (event, ctx) => {
          const result = await toolGuard.beforeToolCall(event, ctx);
          if (result?.block) {
            api.logger?.info?.(
              `[peer-contract-enforcer] [DRY-RUN] would block tool='${event.toolName}' agent='${ctx.agentId}' session='${ctx.sessionKey}': ${result.blockReason}`
            );
            return undefined; // allow in dry-run
          }
          return result;
        }
      : toolGuard.beforeToolCall;

    // ──────────── Tool-level enforcement (HR1/HR2/HR3/HR4/HR6/HR7/HR8/HR9/CONTRACT) ────────────
    api.on("before_tool_call", guardedBeforeToolCall, { priority: 100 });

    // ──────────── Role registry population (HR2/HR3 backing) ────────────
    api.on("subagent_spawned", createSubagentSpawnedHandler(roleRegistry), { priority: 100 });
    api.on("session_start", createSessionStartHandler(roleRegistry), { priority: 100 });
    api.on("session_end", createSessionEndHandler(roleRegistry), { priority: 100 });

    // ──────────── Session lifecycle: register sessionKeys for HR6 session-existence ────────────
    api.on("session_start", async (event) => {
      const sk = event.sessionKey;
      if (!sk) return;
      sessionRegistry.set(sk, {
        agentId: event.agentId,
        parentSessionKey: event.parentSessionKey,
        source: "session_start",
      });
      // Day 6a followup (Kelsen Drift 5 ref review): also feed event.agentId into agentRegistry
      // for Drift 5 whitelist, with RESERVED_SESSION_KINDS blacklist to avoid mis-registering
      // sessionKind segments (e.g. "webchat") as agentIds.
      if (event.agentId && !RESERVED_SESSION_KINDS.has(event.agentId)) {
        agentRegistry.register(event.agentId, { source: "session_start" });
      } else if (event.agentId) {
        api.logger?.info?.(`peer-contract-enforcer: session_start agentId='${event.agentId}' is a reserved sessionKind, not registering in agent registry`);
      }
    }, { priority: 100 });

    api.on("subagent_spawned", async (event) => {
      const childKey = event.childSessionKey;
      if (!childKey) return;
      sessionRegistry.set(childKey, {
        agentId: event.agentId,
        parentSessionKey: event.sessionKey,
        source: "subagent_spawned",
      });
      if (event.agentId && !RESERVED_SESSION_KINDS.has(event.agentId)) {
        agentRegistry.register(event.agentId, { source: "subagent_spawned" });
      }
    }, { priority: 100 });

    api.on("session_end", async (event) => {
      const sk = event.sessionKey;
      if (!sk) return;
      sessionRegistry.delete(sk);
      // acCache lifecycle (Kelsen Risk 2 stale carry-over mitigation):
      const purged = acCache.purgeExpired();
      const agentId = sk.split(":")[1];
      if (agentId) {
        const evicted = acCache.evictByAgent(agentId);
        api.logger?.info?.(`peer-contract-enforcer: session_end evicted ${evicted} AC entries (purged ${purged} expired) for agent='${agentId}'`);
      }
    }, { priority: 100 });

    // ──────────── HR5: message_sending hook → audit cross-session-message ────────────
    api.on("message_sending", async (event) => {
      if (!auditLogger) return;
      await auditLogger.record({
        kind: "cross_session_message",
        toolName: "message_sending",
        channel: event.messageProvider ?? event.channel ?? undefined,
        targetSessionKey: event.sessionKey ?? event.targetSessionKey,
        agentId: event.ctx?.agentId,
        sessionKey: event.ctx?.sessionKey,
        cardId: event.ctx?.cardId,
        runId: event.ctx?.runId,
        meta: {
          threadId: event.threadId,
          messageId: event.messageId,
          contentLength: typeof event.content === "string" ? event.content.length : undefined,
        },
      });
    }, { priority: 100 });

    // ──────────── Day 6b release hooks ────────────
    // - workboard plugin RPC integration for audit logger (replace file sink)
    // - role registry persistence to workboard card metadata
    // - plugin install two-step (plugins.entries + tools.alsoAllow)
  },
});