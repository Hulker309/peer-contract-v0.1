# Post-install Procedures

> What to do AFTER `npm test` is green and OpenClaw is running with the plugin loaded.
> Day-to-day operational procedures for a maintainer.

## Verify the install

After `INSTALL.md` step 3 (gateway restart + verify LISTEN), the plugin should be running. Verify:

```powershell
# Plugin loaded
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' plugins inspect peer-contract-enforcer --runtime
# Expected: "Status: loaded"

# Listen log shows 5 plugins
Get-Content "C:\Users\Administrator\AppData\Local\Temp\openclaw\openclaw-2026-08-22.log" `
    | Select-String -Pattern "http server listening"
# Expected: "5 plugins: memory-core, minimax, peer-contract-enforcer, qqbot, workboard"
```

## Smoke test the plugin end-to-end

The cheapest way to verify the plugin is doing what it should:

### Trigger HR1 (no-default-to-main)

```powershell
# Use OpenClaw Control UI (http://127.0.0.1:18789) or direct session call
# to send a sessions_send with target_session_key = "agent:coder:main" and
# intent = "task_assignment".
# Expect: BLOCK with reason "target_session_key 'agent:coder:main' is a
# main session with intent='task_assignment' (no-default-to-main forbids)"
```

### Trigger HR5 (audit log)

```powershell
# From any session, call sessions_history on any other session.
# Expect: a new line in the audit log:
Get-Content "C:\Users\Administrator\.openclaw\agents\<your-agent>\peer-contract-enforcer-audit.jsonl" `
    | Select-Object -Last 1
# Expected JSON line: {"kind":"cross_session_query", "toolName":"sessions_history",
#                     "agentId":"<your-agent>", "sessionKey":"<your-session>", "correlationId":"..."}
```

### Trigger HR6 (session-existence)

```powershell
# Call sessions_send with a target_session_key that doesn't exist
# (e.g. "agent:phantom:run:abc:def:ghi")
# Expect: BLOCK with reason "target session '...' not found"
```

If any of these don't behave as expected, see [maintainability.md](maintainability.md) §"Common failure modes".

## Audit log operations

The audit log is the primary operational signal for what's happening in the system.

### Where it lives

```
<OPENCLAW_HOME>/agents/<agentId>/peer-contract-enforcer-audit.jsonl
```

Per-agent file routing (Day 6a+ P0-2 fix). `agentId` is sanitized: characters not in `[a-zA-Z0-9_-]` are replaced with `_` to prevent path traversal.

### How to read it

```powershell
# Last 10 events for one agent
Get-Content "C:\Users\Administrator\.openclaw\agents\kelsen\peer-contract-enforcer-audit.jsonl" `
    | Select-Object -Last 10

# All events for a specific thread (using correlationId)
Select-String -Path "C:\Users\Administrator\.openclaw\agents\kelsen\peer-contract-enforcer-audit.jsonl" `
    -Pattern "thread-001"

# All events for one session (using sessionKey)
Select-String -Path "C:\Users\Administrator\.openclaw\agents\kelsen\peer-contract-enforcer-audit.jsonl" `
    -Pattern "agent:kelsen:bus:dispatch-001"
```

### Field schema

Each line is a JSON object with these fields (per `src/audit-logger.js`):

| Field | Type | Description |
|---|---|---|
| `kind` | string | `"cross_session_query"` (sessions_history / memory_search) or `"cross_session_message"` (message_sending) or `"workboard_audit_fallback"` |
| `ts` | number | epoch ms (INTEGER, normalized — see ts normalization in `src/audit-logger.js`) |
| `toolName` | string | tool that triggered the audit |
| `targetSessionKey` | string? | for sessions_history / message_sending |
| `query` | string? | for memory_search |
| `channel` | string? | for message_sending |
| `agentId` | string | caller agent (sanitized) |
| `sessionKey` | string | caller session |
| `cardId` | string? | work session card ID |
| `runId` | string? | OpenClaw run ID |
| `correlationId` | string? | thread ID (Day 6a+ #8) |
| `meta` | object? | additional structured data |

### Retention

There is no automatic rotation or archival. The file grows indefinitely. For long-running systems:

```bash
# Archive by month (manual, run periodically)
$src = "C:\Users\Administrator\.openclaw\agents\kelsen\peer-contract-enforcer-audit.jsonl"
$archive = "C:\Users\Administrator\.openclaw\agents\kelsen\archive\peer-contract-enforcer-audit-2026-08.jsonl"
Move-Item $src $archive -Force
# Note: file is moved, NOT rotated. Plugin will write to a new file at the same path.
# To compress and timestamp the old file, do it before moving:
# Compress-Archive -Path $archive -DestinationPath "$archive.zip"
```

## Session-registry bootstrap

`sessionRegistry` is bootstrapped at plugin startup from `~/.openclaw/agents/<id>/sessions/*.jsonl`. This is how work sessions are pre-registered. Bus and main sessions are registered at runtime.

If a work session is created BEFORE the plugin starts (and the file exists), the bootstrap registers it. If a work session is created AFTER the plugin starts, `session_start` hook registers it.

If HR6 blocks a dispatch with "target session not found", the most common cause is that the target session was created after the plugin's last restart. The fix: trigger an OpenClaw restart, or manually populate `sessionRegistry` (not exposed in user config).

## Configuration changes (hot reload)

OpenClaw's hot reload re-reads `openclaw.json` and the plugin's configSchema. It does NOT re-import the plugin module.

After editing plugin config:
- Config changes apply immediately (next call to plugin re-reads config)
- Plugin source code changes require `kill + restart` of OpenClaw

```powershell
# Config-only change (e.g. changing mainIntentsAllowlist)
# Edit openclaw.json → save → wait ~5s → hot reload applies automatically
# Verify:
Get-Content "C:\Users\Administrator\AppData\Local\Temp\openclaw\openclaw-2026-08-22.log" `
    | Select-String -Pattern "config hot reload"

# Source code change (e.g. adding new HR rule)
# Edit src/ → save → restart gateway
$old = (Get-NetTCPConnection -LocalPort 18789 -State Listen).OwningProcess
Stop-Process -Id $old -Force
Start-Sleep -Seconds 3
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' gateway
Start-Sleep -Seconds 22
Get-NetTCPConnection -LocalPort 18789 -State Listen   # verify LISTEN
```

## Versioning the plugin

`package.json` has `"version": "0.1.0"`. Bump to:
- `0.1.x` → bug fix, no schema change
- `0.2.x` → additive schema change
- `1.0.0` → first stable contract

Update the `version` field in `package.json` after each fix that ships. The `openclaw.json` `plugins.entries.peer-contract-enforcer.config` doesn't have a version field — version is metadata only.

## Operational health check (run weekly)

```powershell
# 1. Plugin loaded
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' plugins inspect peer-contract-enforcer --runtime
# Expected: "Status: loaded"

# 2. Listen log recent (last hour)
Get-Content "C:\Users\Administrator\AppData\Local\Temp\openclaw\openclaw-2026-08-22.log" `
    | Select-String -Pattern "peer-contract-enforcer" `
    | Select-Object -Last 20

# 3. Audit log size (per agent)
Get-ChildItem "C:\Users\Administrator\.openclaw\agents" -Recurse -Filter "peer-contract-enforcer-audit.jsonl" `
    | Select-Object FullName, Length, LastWriteTime `
    | Format-Table -AutoSize

# 4. Tests still pass
cd "C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer"
npm test
# Expected: 166/166 PASS
```

If any of these show unexpected values, see [maintainability.md](maintainability.md) §"Common failure modes".

## When to escalate / when to fix in plugin

The plugin enforces 6 runtime HR rules (HR1/2/3/5/6/7/8) plus 5 contract drift rules (Drift 1-5, Drift 6). When one blocks a legitimate dispatch, the question is: is the dispatch wrong, or is the plugin rule wrong?

- **Dispatch is wrong** (caller bug): the caller should fix their dispatch. Audit log shows the offending call with `correlationId` for tracing. Update the caller.
- **Plugin rule is wrong** (plugin bug): the rule's logic doesn't match the design intent. Open an issue, fix the plugin, add a test, ship.

The `docs/known-limitations.md` file tracks the cases where the design itself is what's wrong (not the dispatch, not the rule). Those are v0.2 candidates.
