// peer-contract-enforcer shared types (JSDoc only, no TypeScript runtime)
/**
 * @typedef {"work" | "bus" | "main" | "unknown"} WorkbenchRole
 *   work: working session, executes task in isolation
 *   bus:  coordination session, task semantics, routing
 *   main: long-term agent memory session (no-default-to-main hard rule)
 *   unknown: sessionKey doesn't match any pattern (conservative: allow)
 */

/**
 * @typedef {Object} SessionRoleInfo
 * @property {WorkbenchRole} role
 * @property {string} [parentSessionKey]
 * @property {string} [agentId]
 * @property {string} [cardId]
 * @property {string} [subTaskId]
 */

/**
 * @typedef {Object} WorkbenchPolicy
 * @property {Set<string>} workDeniedTools
 * @property {Set<string>} workSessionSendWhitelist
 * @property {number} payloadSizeCapBytes
 * @property {RegExp} mainSessionKeyPattern
 * @property {RegExp} workSessionKeyPattern
 * @property {RegExp} busSessionKeyPattern
 */

/**
 * @typedef {Object} ToolCallEvent
 * @property {string} toolName
 * @property {Record<string, unknown>} params
 * @property {string} [toolKind]
 * @property {string} [toolInputKind]
 * @property {string[]} [derivedPaths]
 * @property {string} [runId]
 * @property {string} [toolCallId]
 */

/**
 * @typedef {Object} ToolCallContext
 * @property {string} [agentId]
 * @property {string} [sessionKey]
 * @property {string} [sessionId]
 * @property {string} [runId]
 * @property {string} [toolKind]
 * @property {string} [toolInputKind]
 * @property {string} [messageProvider]
 * @property {string} [channel]
 * @property {string} [channelId]
 * @property {string} [senderId]
 * @property {unknown} [trace]
 */

/**
 * @typedef {Object} BeforeToolCallAllow
 * @property {Record<string, unknown>} [params]
 */

/**
 * @typedef {Object} BeforeToolCallBlock
 * @property {true} block
 * @property {string} blockReason
 */

/**
 * @typedef {BeforeToolCallAllow | BeforeToolCallBlock} BeforeToolCallResult
 */

// Re-export as plain const for JSDoc consumers
export const WORKBENCH_ROLES = Object.freeze({
  WORK: "work",
  BUS: "bus",
  MAIN: "main",
  UNKNOWN: "unknown",
});
