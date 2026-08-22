# Maintainability

> How to extend, debug, and fix the peer-contract v0.1 plugin without breaking it.

## The 8-fix history (read this first)

This plugin went through 8 fix iterations during Day 6 install. Each fix is a lesson. **Read all 8 before making changes.**

| # | When | What broke | Root cause | Fix | Lesson |
|---|---|---|---|---|---|
| 1 | 7:15 | plugin install aborts silently | `path` field in `plugins.entries.<id>` not in configSchema allowlist | delete `path`, add to `plugins.allow` | **plugin metadata goes in `allow`, config goes in `entries.<id>.config`** |
| 2 | 7:21 | `plugin register must be synchronous` | `async register(api)` returns Promise, OpenClaw strict-sync guard | `register` sync, internal `await` → fire-and-forget | **OpenClaw 0.7.1+ plugin register is sync-only** |
| 3 | 7:21 | `Missing config` despite `config validate` exit 0 | `openclaw.json` has UTF-8 BOM, node JSON.parse rejects | strip BOM | **always check `config validate` AFTER config edit, restart-after-edit** |
| 4 | 8:22 | auto-fill correlation_id doesn't reach Coder | `extractDispatchPayload` parses `event.params.message` (string) to new object, mutates new object, OpenClaw delivers original | write mutated payload back to `event.params.message` (Day 6a+ P0-1) | **mutation in copy is silent. Trace data flow end-to-end.** |
| 5 | 8:22 | audit log correlationId 0 hits | `event.params.correlation_id` undefined, `ctx.correlationId` undefined, `sessionEntry.correlationId` undefined (3-level fallback all empty) | pre-fill `sessionRegistry` from `before_tool_call`, inherit in `session_start` (Day 6a+ P0-2) | **fallback chain is meaningless if all sources are empty. Pre-fill at the source.** |
| 6 | 8:22 | HR1 cross-agent-to-work doesn't fire for `agent:coder:run:xxx` | default `workSessionKeyPattern` only matched `work:`, not OpenClaw's actual `run:` | default pattern now `(work|run)` (Day 6a+ P1) | **verify defaults against actual runtime session key format, not just spec examples** |
| 7 | 8:22 | 4 unit tests fail after Issue 1/2/3 + #8 | tests used `agent:coder:work:...` keys | added `makeSameAgentV2Dispatch` helper, updated 6+ tests to use it | **test fixtures should match runtime reality, not just spec examples** |
| 8 | 8:22 | `session_start` overwrites `parentSessionKey` to `undefined` | role-registry session_start handler ignores existing entry | inherit `parentSessionKey` / `subTaskId` / `cardId` from existing entry (Day 6a+++ P0-3) | **read existing state in lifecycle handlers; never overwrite to defaults** |

## Adding a new HR rule

1. Add the rule to `spec/01-dispatch.schema.json` (or whichever spec) as a static constraint if it can be expressed in JSON Schema
2. If runtime enforcement is needed, add the validator function to `src/dispatch-schema.js` (for payload-shape rules) or `src/contract-compliance.js` (for cross-cutting rules)
3. Call the validator from `validateDispatchSchema` (payload) or `validateContractCompliance` (cross-cutting)
4. Add a test case in `tests/hr1-hr6-schema-validation.test.mjs` (or appropriate test file)
5. Update `docs/architecture.md` to document the new rule

For new HR rules, follow the order: static (schema) first, runtime (plugin) second, audit (HR5-style) last.

## Extending the schema

1. Edit the relevant `spec/*.schema.json` (use Draft 2020-12 syntax)
2. If the field is required at the schema level, add to `V2_REQUIRED_TOP_FIELDS` in `src/dispatch-schema.js:20-41`
3. If the field needs runtime validation, add to the corresponding validator function
4. Update tests
5. **Do not** add fields to `V2_REQUIRED_TOP_FIELDS` that aren't also in the spec — runtime schema should be a subset of public spec

## Debugging a runtime check failure

When `sessions_send` returns a block, the `blockReason` includes the HR rule and the field. To debug:

1. **Identify the layer**: `blockReason` format is `HR<n>: <field>: <message> [<reason>]`
   - `HR1` → `validateNoDefaultToMain` in `src/dispatch-schema.js`
   - `HR2` → `tool-guard.js` line ~198 (work→bus parent check)
   - `HR3` → `tool-guard.js` line ~141 (channel→work)
   - `HR4` → `validatePayloadSelfContained` in `src/dispatch-validator.js`
   - `HR6` → `validateV2Schema` (required fields) or `validateSessionExistence` (target not found)
   - `HR7` → `tool-guard.js` line ~129 (AC immutability)
   - `HR8` → `validatePayloadSize` in `src/dispatch-schema.js`
   - `HR9` → `tool-guard.js` line ~62 (work toolset deny)
   - `CONTRACT` → `validateContractCompliance` in `src/contract-compliance.js` (Drift 1-6)

2. **Trace the data flow**:
   - The OpenClaw event object → `event.params` (sessions_send call args) → extractDispatchPayload → payload
   - For `v2_message_string` shape: payload is `JSON.parse(event.params.message)` — a new object. Mutations on payload don't affect the original string (Day 6a+ P0-1 fix wrote this back).
   - For `v2_top_level` / `v2_message_object`: payload IS `event.params` (or a sub-object). Mutations DO affect the original (intentional, so caller can read updated fields).

3. **Check session-registry** for the target session: `sessionRegistry.get(targetSessionKey)` — if undefined, HR6 session-existence blocks.

4. **Check role-registry** for the sender session: `roleRegistry.get(senderSessionKey)` — if `parentSessionKey` is undefined, HR2 parent check short-circuits (Day 6a+++ P0-3 fix preserves it).

5. **Check audit log** for the call: `~/.openclaw/agents/<agentId>/peer-contract-enforcer-audit.jsonl` — append-only, shows the call's `correlationId` (if set) and the `blockReason` for blocked calls.

## Testing a fix

The 8-fix history taught us: **unit tests + end-to-end tests + source review** are all needed, in that order.

1. **Unit test**: add a case to the appropriate test file. Run `npm test`. If green, proceed.
2. **Source review**: before declaring a fix done, manually trace the data flow. Ask:
   - Does this mutation land in the right place (copy vs original)?
   - Is this fallback chain actually reachable (don't trust 3-level fallbacks without verifying each level)?
   - Does this default match OpenClaw's runtime, not just the spec example?
3. **End-to-end test**: use OpenClaw's actual session key formats (`agent:coder:run:v1.1-sync`, not `agent:coder:work:abc`), and run the actual call path. Don't mock too much.

## When a "passing" test is actually a bug

A test that passes doesn't mean the behavior is correct. Examples from the 8-fix history:

- **`v2_message_string` test PASSED but Coder received `correlation_id: null`**: the test verified the plugin ACCEPTED the dispatch; it didn't verify that Coder's inbound message had the auto-filled value. **Tests must verify the end-to-end data path, not just the API surface.**

- **`#8.4 audit log correlationId` test FAILED on real data**: 3-level fallback chain all returned undefined because OpenClaw event schema doesn't propagate `correlationId`. **Tests with mocked event data can pass while the real behavior fails.**

- **`#8.1 auto-fill` test PASSED with `correlation_id="d-..."`**: the test used `v2_top_level` shape, where mutations DO land in the original payload. The same logic with `v2_message_string` shape (string parsed to new object) silently failed. **Tests must cover all shapes the plugin supports.**

The fix: every plugin fix needs at least one end-to-end test that exercises the actual data path, not the API surface.

## Adding a new session key pattern

If OpenClaw adds a new session key shape (e.g. `agent:coder:agent:foo:bar:xyz`), the plugin's pattern matching needs to know about it:

1. Update `src/workbench-policy.js` default patterns (`mainSessionKeyPattern`, `workSessionKeyPattern`, `busSessionKeyPattern`) — or override via `openclaw.json` config
2. Update `src/role-registry.js` `createSessionStartHandler` regex to recognize the new shape and infer role
3. Update `src/role-registry.js` `createSubagentSpawnedHandler` regex to extract `cardId` / `subTaskId`
4. Add test cases in `tests/role-registry-lifecycle.test.mjs`
5. If the new shape has a parent/sibling concept, update `src/tool-guard.js` HR2 parent check

## Common failure modes (post-ship)

| Symptom | Likely cause | Fix |
|---|---|---|
| `plugin failed during register: Error: plugin register must be synchronous` | `register` is `async` | change to `sync`, move `await` to `.then().catch()` |
| `Config is invalid: plugins.entries.peer-contract-enforcer: Invalid input` | config field not in `configSchema.properties` allowlist | check `openclaw.plugin.json` configSchema, only use declared fields |
| `Missing config` after restart | OpenClaw 0.7.1+ doesn't read `OPENCLAW_HOME` | unset `OPENCLAW_HOME`, use `OPENCLAW_STATE_DIR` if needed |
| Plugin not loaded after restart | OpenClaw hot reload doesn't re-import module | `kill + restart` gateway (not just config reload) |
| Audit log has `correlationId: undefined` | 3-level fallback all empty (see 8-fix #5) | pre-fill session-registry at `before_tool_call`, inherit in `session_start` |
| HR2 cross-agent work→bus not blocked | `parentSessionKey` is undefined (see 8-fix #8) | check `session_start` inherits from existing entry |
| `accept` returns wrong value to caller | `v2_message_string` mutation not written back (see 8-fix #4) | `event.params.message = JSON.stringify(params)` after validation |

## Code style conventions

- **All source files use ES modules** (`import` / `export`, not `require` / `module.exports`)
- **All test files use Node.js built-in test runner** (`node:test` / `assert`) — no `jest`, no `mocha`
- **Indentation**: 2 spaces, no tabs
- **Naming**: `camelCase` for variables/functions, `PascalCase` for classes/types, `kebab-case` for filenames
- **Comments**: JSDoc on all exported functions, inline `// Day N: ...` for non-obvious code paths
- **Async**: only `async` for true async; for `Promise` return, return explicitly to avoid `async` keyword side effects
- **Errors**: throw plain `Error` subclasses with structured `{hr, field, reason, message}` shape; `formatBlockReason` joins them with ` | ` for the OpenClaw runtime
