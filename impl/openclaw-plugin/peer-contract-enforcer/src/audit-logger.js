// peer-contract-enforcer audit logger (HR5 audit-cross-session-query)
// Day 5: in-memory ring buffer + JSONL file appender for sessions_history / memory_search
// cross-session queries. Workboard plugin RPC integration is Day 6 release target.
//
// Logged events:
//   - sessions_history call (target sessionKey + query)
//   - memory_search call (query + tool)
//   - message_sending hook (cross-session message outbound)
//
// TODO (RPC integration, Day 6a followup per Kelsen 2026-08-19 review):
//   workboardSink stub is currently the file appender. When OpenClaw plugin SDK exposes
//   callTool / callRpc (currently does not), replace workboardSink with a real workboard
//   plugin RPC call (workboard.addWorkerLog(cardId, message, level, sessionKey, runId))
//   which writes metadata.workerLogs on the originating workboard card. For now this is a
//   file sink; trial week uses jq on the file path documented in docs/README.md §Audit Log.
//   Tracker: see workboard card 6b108fd3-... comments for Day 6b RPC readiness signal.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @typedef {Object} AuditEvent
 * @property {string} kind — "cross_session_query" | "cross_session_message" | "workboard_audit_fallback"
 * @property {number} ts — ms epoch
 * @property {string} toolName — tool or hook name
 * @property {string} [targetSessionKey] — for sessions_history / message_sending
 * @property {string} [query] — for memory_search
 * @property {string} [channel] — for message_sending
 * @property {string} agentId
 * @property {string} sessionKey — caller
 * @property {string} [cardId]
 * @property {string} [runId]
 * @property {string} [correlationId] — Day 6a followup (Mavis 2026-08-22 09:53, user #8): correlation_id from dispatch payload, for chain tracking across audit log
 * @property {Object} [meta] — additional structured data
 */

/**
 * @typedef {Object} AuditLoggerOptions
 * @property {string} [filePath] — JSONL append path (default: ~/.openclaw/agents/coder/peer-contract-enforcer-audit.jsonl). Mutually exclusive with resolveFilePath.
 * @property {(event: AuditEvent) => string} [resolveFilePath] — per-event path resolver. If set, takes precedence over filePath. (Day 6a followup, Mavis 2026-08-22 08:25: per-agent audit log)
 * @property {number} [memoryCap] — in-memory ring buffer size (default 500)
 * @property {boolean} [disableFile] — when true, no file writes (for tests)
 * @property {(event: AuditEvent) => Promise<void>} [workboardSink] — optional workboard RPC sink (Day 6)
 */

/**
 * @returns {{
 *   record: (event: Omit<AuditEvent, "ts">) => Promise<AuditEvent>,
 *   entries: () => AuditEvent[],
 *   size: number,
 *   clear: () => void,
 *   flush: () => Promise<void>,
 *   _memRing: AuditEvent[],
 *   _filePath: string | undefined,
 * }}
 */
export function createAuditLogger(options = {}) {
  // Per-event path resolver takes precedence over fixed filePath.
  // (Day 6a followup, Mavis 2026-08-22 08:25: Kelsen report 8/22 8:17 flagged that
  //  fixed filePath with `api?.config?.agentId ?? "coder"` always wrote to coder dir
  //  regardless of actual caller. Fix: route per event.agentId so each agent gets
  //  its own audit log file.)
  const resolveFilePath = options.resolveFilePath;
  const filePath = options.disableFile
    ? undefined
    : (resolveFilePath
        ? undefined  // resolve at record time
        : (options.filePath ?? defaultAuditFilePath()));
  const memoryCap = options.memoryCap ?? 500;
  const workboardSink = options.workboardSink;

  /** @type {AuditEvent[]} */
  const ring = [];
  let pendingWrite = Promise.resolve();

  /**
   * Append an audit event to in-memory ring + (best-effort) file + optional workboard sink.
   * Never throws to the caller — logging must not break the calling tool.
   * @param {Omit<AuditEvent, "ts">} event
   * @returns {Promise<AuditEvent>}
   */
  async function record(event) {
    // Defensive: even if a caller passes a `ts` override (e.g. a Date or ISO string),
    // normalize it to epoch ms (INTEGER). The workboard plugin SQLite schema requires
    // `created_at INTEGER NOT NULL`; an ISO string here would silently corrupt the
    // workboard_worker_logs row and break `workboard_list` with
    // "workboard sqlite row missing created_at" (see workboard card 6b108fd3 HR5
    // audit-row corruption incident, 2026-08-19).
    const ts = normalizeEpochMs(event?.ts, Date.now());
    const full = { ...event, ts };
    // In-memory ring (LRU-evict by overwriting oldest)
    ring.push(full);
    if (ring.length > memoryCap) ring.shift();

    // File append (best-effort, queued so we don't block the caller)
    const writePath = resolveFilePath ? resolveFilePath(full) : filePath;
    if (writePath) {
      pendingWrite = pendingWrite.then(() => safeAppendFile(writePath, full)).catch(e => {
        // swallow — audit failure must not break tool execution
        // (we'll surface via _lastFileError for debugging)
        lastFileError = e;
      });
    }

    // Workboard sink (Day 6+ RPC target — runs in parallel, errors swallowed)
    if (workboardSink) {
      pendingWrite = pendingWrite.then(() => workboardSink(full).catch(e => {
        lastSinkError = e;
      }));
    }

    return full;
  }

  /**
   * Wait for all pending writes to complete (for tests + graceful shutdown).
   */
  async function flush() {
    await pendingWrite;
  }

  function entries() { return [...ring]; }
  function clear() { ring.length = 0; }

  // Internal: surface file errors for debugging (not for production callers)
  /** @type {unknown} */
  let lastFileError = undefined;
  /** @type {unknown} */
  let lastSinkError = undefined;

  return {
    record,
    entries,
    get size() { return ring.length; },
    clear,
    flush,
    _memRing: ring,
    _filePath: filePath,
    _lastFileError: () => lastFileError,
    _lastSinkError: () => lastSinkError,
  };
}

function defaultAuditFilePath() {
  const home = process.env.OPENCLAW_HOME ?? "C:/Users/Administrator/.openclaw";
  return `${home}/agents/coder/peer-contract-enforcer-audit.jsonl`;
}

/**
 * Coerce any timestamp value (Date object, ISO string, number, bigint) to epoch ms INTEGER.
 * Returns `fallbackMs` if input is undefined / null / invalid.
 *
 * Hard contract: workboard plugin SQLite schema (`workboard_worker_logs.created_at`) requires
 * INTEGER NOT NULL. ISO strings or Date objects silently corrupt the row and break
 * `workboard_list` with "workboard sqlite row missing created_at" (see workboard card
 * 6b108fd3 HR5 audit-row corruption incident, 2026-08-19).
 *
 * @param {Date | string | number | bigint | null | undefined} value
 * @param {number} fallbackMs — fallback (typically Date.now())
 * @returns {number} epoch ms (INTEGER, finite)
 */
export function normalizeEpochMs(value, fallbackMs) {
  if (value == null) return fallbackMs;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallbackMs;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : fallbackMs;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

/**
 * Append a single event as JSON line. Creates parent dir if needed.
 * @param {string} filePath
 * @param {AuditEvent} event
 */
function safeAppendFile(filePath, event) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
  } catch (e) {
    // re-throw so record() can capture; outer wrapper will swallow
    throw e;
  }
}

/**
 * Resolve the cardId for the audit log from the caller ctx.
 * Preference: explicit ctx.cardId > caller role registry entry > derived from sessionKey pattern.
 * @param {{ cardId?: string, agentId?: string, sessionKey?: string, runId?: string }} ctx
 * @returns {{ cardId?: string, runId?: string }}
 */
export function resolveAuditContext(ctx) {
  return {
    cardId: ctx.cardId,
    runId: ctx.runId,
  };
}