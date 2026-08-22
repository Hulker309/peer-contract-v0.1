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
