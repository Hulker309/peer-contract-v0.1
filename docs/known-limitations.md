# Known Limitations

> Future work deferred from v0.1. Recorded so contributors don't re-litigate decisions; if a use case demands one of these, it's a v0.2 candidate (not yet planned).

## Summary

| # | Limitation | Impact | Workaround | Status |
|---|---|---|---|---|
| 1 | v1.1 ↔ v0.1 compat shim | Coder-side dispatch uses old format → Drift 2 blocks | Coder must migrate to v0.1 dispatch format | **Decided: don't ship compat shim** |
| 2 | per-agent config hooks | All agents share one policy; can't tune per-agent | Single global config | Open, future work |
| 3 | AC chain validation | correlation_id present, but chain consistency not validated | Use audit log to trace; manual review | Open, future work |
| 4 | v0.1 work session message tool | Coder can use `message` (HR9 deny) | workaround via disk sync | Open, future work |
| 5 | No reply routing enforcement | reply_to field required (v1.1 contract), but plugin doesn't enforce chain | Drift 2 catches missing; valid reply_to is not chain-validated | Open, future work |
| 6 | No bus topology validation | plugin allows any bus↔bus regardless of declared topology | rely on bus session key conventions | Open, future work |

## Day 8 update (2026-08-24) — HR5.1 bus-context-required

**Status change**: #6 "No bus topology validation" remains open (full topology graph is still v0.2), but a **partial enforcement** landed: HR5.1 now requires `agent:<id>:bus:<context-id>` to include a non-empty `context-id` segment. Bare `agent:<id>:bus` (the Kelsen 8/24 4-agent bootstrap default) is now BLOCKED.

**Why this was added**: 老板 2026-08-24 08:10 feedback pointed out that bare bus keys collapse to a single shared inbox, which is the same cross-task contamination that the v0.1 bus coordination design was built to avoid (see `docs/bus-coordination.md` "Bus is NOT a simple message queue"). The plugin up to Day 7 accepted any bus shape because `busSessionKeyPattern` defaulted to `^agent:[^:]+:bus(:.*)?$` (zero-or-more trailing segments). HR5.1 closes the "zero segments" hole.

**What HR5.1 does**:
- In `validateDispatchSchema` Step 5.1, when `target_role === "bus"`, the `target_session_key` must match `^agent:[^:]+:bus:.+$` (at least one non-empty segment after `:bus:`).
- Opt-out: set `busContextRequired: false` in plugin config (explicit, not silent).
- Sender-side bus keys (e.g. main's own bus) are NOT enforced — only target-side.

**Side effects**:
- All existing tests pass (166/166) — the test suite already used per-context bus keys everywhere.
- **Callers using bare `agent:<id>:bus` (Kelsen 8/24 4-agent bootstrap, 4 new agents) will be BLOCKED** until they update their dispatch to use per-context bus keys. This is the intended behavior; the v0.1 spec design has always been per-context.
- `spec/04-bus.schema.json` should be updated in a follow-up to formally require `context-id` (Day 8 added the enforcement but not the schema-level requirement — open).

**Operator migration**: when upgrading, search your dispatch sites for the bare `:bus"` suffix and add a context segment. Common patterns:
- `agent:<id>:bus:dashboard` (single dashboard per agent)
- `agent:<id>:bus:webchat:<user-id>` (per-user channel)
- `agent:<id>:bus:dispatch` (dispatch hub, per task)
- `agent:<id>:bus:webchat:<user-id>:<task-id>` (per-user-per-task, multi-segment)

**Related spec section**: see `docs/bus-coordination.md` §"Bus session types" for the canonical key shape.

## Day 8 v2 update (2026-08-24, 老板 10:50 提示"结合 workboard") — task dependency + multi-target broadcast

**Status change**:
- **#3 (AC chain validation)**: now **delegated to workboard**. peer-contract-enforcer HR10 only validates `parent_task_id` schema (UUID format = workboard card id). Actual dependency-graph enforcement is the workboard plugin's `linkCards` + `promoteReady` private methods. The plugin no longer maintains its own task-registry (Day 8 v1 intermediate design was rejected at 10:50; ship is the leaner v2).
- **#4 (work session message tool)**: unchanged. Work sessions still can't `message` external channels (HR9 deny list).
- **#5 (reply routing enforcement)**: unchanged. `in_reply_to` chain not validated.
- **#6 (bus topology)**: unchanged. Bus dispatch fan-out is `target_session_keys` array schema (HR5.1 multi), but actual delivery is caller's responsibility (plugin validates array, caller fires N `sessions_send` calls).

**Day 8 v2 design rationale** (老板 10:50): "结合 openclaw 自己的 workboard 功能" — workboard is already task lifecycle source-of-truth. Building a parallel task-registry in peer-contract-enforcer would be redundant state that drifts from the canonical source. Plugin's scope is "agent↔agent message protocol", not "workflow engine".

**New wire-format fields** (spec/01-dispatch + 04-bus):
- `routing.parent_task_id`: optional UUID, workboard card id of upstream dependency
- `routing.target_session_keys`: optional array, multi-target fan-out (mutually exclusive with `target_session_key`)
- `bus.broadcast.scope` enum: added `explicit_target_session_keys` value
- `bus.broadcast.multi_target_session_keys`: optional array, explicit target list

**Plugin enforcement**:
- HR10 schema-only (UUID format check). Helpful BLOCK message points to workboard card id format.
- HR5.1 multi-target: each array entry must satisfy bus-context-required rule.

**Plugin deletions** (vs Day 8 v1):
- `src/task-registry.js` — removed (workboard is source-of-truth)
- yield_report / task_assignment state-update hooks in `tool-guard.js` — removed
- `createTaskRegistry` injection in `index.js` — removed

**Tests**: 23 new + 166 prior = 189 total, all PASS.

**Migration for operators** (in 4 agent AGENTS.md §6 "workboard 集成"):
- Use `workboard.createCard(...)` to make a card; capture the returned `card.id`
- Use `workboard.linkCards(parentCardId, childCardId)` to wire up dependencies
- Use `workboard.complete(cardId, { summary, artifacts })` to mark done
- Use `workboard.block(cardId, { reason })` to mark failed/blocked
- In `sessions_send` envelope, set `bus.task_assignment.parent_task_id` to the workboard card id
- For multi-target broadcast, use `target_session_keys` array (or N separate `sessions_send` calls)

## 1. v1.1 ↔ v0.1 compat shim

**Decision (2026-08-22 06:14, user拍)**: do not ship a compat shim. v0.1 is the wire format. Coder must migrate to v0.1 dispatch format.

**Why**: keeping compat shim adds a code path that's never exercised in production (everyone should be on v0.1), and creates ambiguity in audit logs (was this a v1.1 or v0.1 dispatch?).

**Workaround**: Coder side updates its dispatch helper to use v0.1 format. The CLI's `check` command catches v1.1-format dispatches immediately with `Drift 2: reply_to_missing`.

## 2. per-agent config hooks

**What**: today, all agents share one policy (one `mainIntentsAllowlist`, one `crossAgentToWorkBlocked`, etc.). Different agents could plausibly want different policies — e.g. Kelsen (CEO) might allow `task_assignment` to its own main, while Coder (worker) shouldn't.

**Why deferred**: not in v0.1 strategic scope. Plugin strategic scope is "agent↔agent protocol", and per-agent config hooks are an internal-to-runtime concern, not a protocol concern.

**Workaround**: use `dryRun: true` for the agent that needs different rules, run plugin offline to validate, then `dryRun: false` for production enforcement.

**v0.2 candidate**: per-agent config overrides via `openclaw.json` `plugins.entries.peer-contract-enforcer.configOverrides.<agentId>`.

## 3. AC chain validation

**What**: today, plugin tracks `correlation_id` across dispatches (auto-fill, pre-fill, session_start inherit) and writes to audit log. But it does NOT validate the chain:

- If sub-task A sets `correlation_id="thread-001"`, and sub-task B (different chain) also sets `correlation_id="thread-001"`, plugin doesn't notice
- If reply comes back with a different `correlation_id` than the original task, plugin doesn't notice
- Chain consistency is only verifiable by human reading the audit log

**Why deferred**: requires session-level state of "what correlation_id is each session in" — significant complexity, not in v0.1 scope.

**Workaround**: use audit log to manually trace chains:
```powershell
Get-Content "C:\Users\Administrator\.openclaw\agents\kelsen\peer-contract-enforcer-audit.jsonl" | Select-String -Pattern "thread-001"
```

**v0.2 candidate**: chain validation pass that compares every `correlation_id` to a "thread registry" and emits warnings on inconsistency.

## 4. Coder's `message` tool blocked

**What**: HR9 denies `message` to work sessions. Coder needs to send messages to bus sessions to "yield back" (e.g. after completing work, notify the bus). But `message` is denied, so Coder writes to disk and the bus reads.

**Why**: HR9 deny list includes `message` because chat channels are bus territory. Work session writing to chat = protocol violation.

**Workaround**: Coder writes to a known path (`/tmp/coder-yield/<task-id>.json`), bus polls or uses `file_watcher` tool. Not clean, but works.

**v0.2 candidate**: per-agent exception for `message` tool, or a dedicated `yield_report` tool that's whitelisted for work.

## 5. reply_to chain not enforced

**What**: v1.1 contract requires `reply_to` field; plugin enforces presence (Drift 2). But it doesn't validate the chain — anyone can claim any `reply_to`, no link to the actual original task.

**Why**: validation would require tracking all `dispatch_id` values in a registry and checking that each `reply_to` points to a real prior dispatch. Significant state.

**Workaround**: rely on the correlation_id chain to trace replies back to originals.

**v0.2 candidate**: maintain a `dispatchRegistry` mapping `dispatch_id → { correlation_id, parent_dispatch_id, agentId }`, validate `reply_to` against it.

## 6. No bus topology validation

**What**: plugin allows `Kelsen.bus → coder.bus` cross-agent dispatch without checking that Kelsen and coder have a declared coordination relationship. In a real multi-agent system, you'd want bus sessions to declare their "upstream" / "downstream" peers and validate dispatch against the declared graph.

**Why deferred**: v0.1 protocol is about the message shape, not the agent graph. Bus topology is a higher-level concern.

**Workaround**: rely on session key conventions (`agent:<id>:bus:...`).

**v0.2 candidate**: `openclaw.json` `plugins.entries.peer-contract-enforcer.busTopology` declaration + plugin validates against it.

## Deferred scope: out of v0.1 entirely

These were considered and explicitly excluded from v0.1:

- **Multi-tenant auth**: no auth, no namespace. Add at the transport layer.
- **Workflow DAG engine**: AC chain tracks acceptance criteria, not DAG dependencies. Use a workflow engine on top.
- **Schema versioning across major versions**: v0.1 → v1.0 would be a breaking change with no auto-migration.
- **Persistent audit log store**: today the audit log is per-agent JSONL files. Workboard integration was planned (Day 6b RPC) but deferred.

## What was decided explicitly (and why)

These were debated in the 8/22 9:00–11:20 timeline; recorded here so they don't get re-opened without cause:

| Decision | Why | Source |
|---|---|---|
| v0.1 strategic scope = `agent↔agent` only (HR1/HR5/HR6). HR2/3/9 dormant. | B 方案 user拍 (8/22 7:14) | `docs/architecture.md` |
| Cross-agent-to-work blocked | user architectural critique (9/22 9:21) | `docs/architecture.md` |
| Drop v1.1 compat | user拍 (6/14) | (this file §1) |
| One-shot, no v0.2 | user拍 (9/22 9:48) | `README.md` |
| `dryRun: false` (enforce mode) | user拍 (6/22 06:09) | `README.md` |
| Per-agent `work` / `run` both work | Kelsen 8/22 9:06 Issue 1 (P1 fix) | `docs/architecture.md` |
| `correlation_id` auto-fill = `dispatch_id` for new task roots | Mavis (Day 6a+ #8) | `docs/architecture.md` |
| `correlation_id` validation (Drift 6) for sub-tasks | Mavis (Day 6a+ #8) | `docs/architecture.md` |
| `parentSessionKey` inherit from existing entry | Mavis (Day 6a+++ P0-3) | `docs/architecture.md` |
