# peer-contract v0.1 — INSTALL

> Verified install procedure for OpenClaw 0.7.1+ on Windows + PowerShell 5.1.
> Author: Mavis (peer agent)  |  Last verified: 2026-08-22 11:20 GMT+8

## TL;DR

Three steps. **Zero `npm install -g`, zero PATH change, zero pollution of other software (Hermes, OpenClaw prod, Windows)**.

```powershell
# 1. Copy plugin to OpenClaw extensions dir
$dst = 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer'
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -Path $dst -ItemType Directory -Force
Copy-Item -Path 'D:\Game and Files\develop\projects\skills\test1\新建\peer-contract-v0.1\impl\openclaw-plugin\peer-contract-enforcer\*' `
          -Destination $dst -Recurse -Force

# 2. Add plugin entry to openclaw.json
$cfg = 'C:\Users\Administrator\.openclaw\openclaw.json'
$oc = Get-Content $cfg -Raw | ConvertFrom-Json
$oc.plugins.entries.'peer-contract-enforcer' = @{
    enabled = $true
    config  = @{
        dryRun                  = $false
        auditQueryContent       = $false
        payloadSizeCapBytes     = 65536
        mainSessionKeyPattern   = '^agent:[^:]+:main(:.*)?$'
        workSessionKeyPattern   = '^agent:[^:]+:(work|run)(:.*)?$'
        busSessionKeyPattern    = '^agent:[^:]+:bus(:.*)?$'
        mainIntentsAllowlist    = @('inform','query','sub-task','response','ack','ping')
        crossAgentToWorkBlocked = $true
    }
}
if (-not ($oc.plugins.allow -contains 'peer-contract-enforcer')) {
    $oc.plugins.allow = @($oc.plugins.allow) + 'peer-contract-enforcer'
}
$oc | ConvertTo-Json -Depth 12 | Set-Content $cfg -Encoding UTF8

# 3. Validate config + restart gateway
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' config validate
# Expected: "Config valid: ~\.openclaw\openclaw.json" exit 0

$old = (Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($old) { Stop-Process -Id $old -Force; Start-Sleep -Seconds 3 }
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' gateway
Start-Sleep -Seconds 22
Get-NetTCPConnection -LocalPort 18789 -State Listen   # should LISTEN
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' plugins inspect peer-contract-enforcer --runtime
# Expected: "Status: loaded"
```

## Verify

```bash
# Tests
cd C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer
npm test
# Expected: 166/166 PASS

# CLI (zero install, just run)
node D:\Game and Files\develop\projects\skills\test1\新建\peer-contract-v0.1\impl\cli\bin\peer-contract.js --version
# Expected: peer-contract 0.1.0

node D:\...\impl\cli\bin\peer-contract.js check D:\...\impl\cli\tests\test-envelope-ok.json
# Expected: OK envelope valid, exit 0
```

## How the plugin works

Once installed, the plugin hooks into OpenClaw's tool-call pipeline:

| Hook | Fires on | Plugin behavior |
|---|---|---|
| `before_tool_call` | every tool call | Validates `sessions_send` envelopes against v0.1 schema + HR1/HR2/HR3/HR4/HR6/HR7/HR8/HR9 rules. Blocks with structured `blockReason` on violation. |
| `subagent_spawned` | new sub-session created | Registers the child session as a "work" role with `parentSessionKey` pointing to the dispatcher. |
| `session_start` | any session opens | Populates role-registry, session-registry, agent-registry, with **inheritance from any pre-existing entry** (so `parentSessionKey` set by `subagent_spawned` survives). |
| `session_end` | any session closes | Cleans up registries. |
| `message_sending` | cross-session message | Appends to per-agent audit log (`peer-contract-enforcer-audit.jsonl`). |

The full install record (3 blockers fixed, 8 fix iterations, 4 end-to-end bug rounds) is in `impl/openclaw-plugin/peer-contract-enforcer/INSTALL_NOTES.md`.

## Uninstall (rollback)

```powershell
# 1. Stop OpenClaw
$pid18789 = (Get-NetTCPConnection -LocalPort 18789 -State Listen).OwningProcess
Stop-Process -Id $pid18789 -Force
Start-Sleep -Seconds 3

# 2. Remove plugin entry from openclaw.json
$oc = Get-Content 'C:\Users\Administrator\.openclaw\openclaw.json' -Raw | ConvertFrom-Json
$oc.plugins.entries.'peer-contract-enforcer' = $null
$oc.plugins.allow = @($oc.plugins.allow | Where-Object { $_ -ne 'peer-contract-enforcer' })
$oc | ConvertTo-Json -Depth 12 | Set-Content 'C:\Users\Administrator\.openclaw\openclaw.json' -Encoding UTF8

# 3. Remove plugin install
Remove-Item 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer' -Recurse -Force

# 4. Restart OpenClaw
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' gateway
Start-Sleep -Seconds 20
Get-NetTCPConnection -LocalPort 18789 -State Listen   # should LISTEN
```

**No leftover state**: no global npm packages, no PATH change, no env vars, no user-level config change. (If you added a `function peer-contract` PowerShell profile alias, remove it yourself.)

## No-pollution guarantee

| Type | Status |
|---|---|
| `npm install -g` packages | **not touched** (CLI has zero deps; plugin deps are local to plugin dir) |
| PATH | **not touched** (no `setx`, no `npm link`) |
| User-level config (`.bashrc`, PowerShell profile) | **optional** (only the `function peer-contract` alias in the example, opt-in) |
| System config (registry, services) | **not touched** |
| Other software (Hermes, OpenClaw prod) | **not touched** (only adds 1 plugin entry to `openclaw.json`) |
| Network ports | **not opened** (no new listeners, no firewall change) |
| Audit log | per-agent at `C:\Users\Administrator\.openclaw\agents\<agentId>\peer-contract-enforcer-audit.jsonl` (delete = delete, no global state) |

## Troubleshooting

### "Missing config" error after install
OpenClaw can't find `openclaw.json`. Verify:
```powershell
Test-Path 'C:\Users\Administrator\.openclaw\openclaw.json'
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' config validate
```
OpenClaw 0.7.1+ does NOT read `OPENCLAW_HOME` env var. Use `OPENCLAW_STATE_DIR` for non-default locations.

### "Config is invalid" after config edit
Schema rejection — your `config` field isn't in the plugin's `configSchema.properties` allowlist. Run:
```powershell
Get-Content 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer\openclaw.plugin.json' | Select-String -Pattern '"properties"'
```
…to see allowed fields, and adjust your `config` block to only use those.

### "plugin register must be synchronous"
Plugin's `register()` function is `async` (returns a Promise). OpenClaw 0.7.1+ strict-sync guard rejects. Edit `src/index.js` to make `register` sync; do internal async work in fire-and-forget `.then().catch()`.

### Plugin not loaded after restart
Hot reload doesn't re-import plugin module. Always `kill + restart` gateway after plugin src changes.

### Audit log not finding per-agent file
Plugin's `auditLogger` resolves file path from `event.agentId` at record time. Sanitize:
- agentId must be a real agent (in `agentRegistry`)
- File path: `<OPENCLAW_HOME>/agents/<safe-agentId>/peer-contract-enforcer-audit.jsonl`
- `safe-agentId` strips characters not in `[a-zA-Z0-9_-]` to prevent path traversal

## How to verify the install is working

The plugin runs in OpenClaw's runtime. To trigger it:

1. **Trigger HR1** (no-default-to-main): from a bus session, call `sessions_send` with `target_session_key` ending in `:main` and `intent: task_assignment`. Expect: BLOCK with reason `target_session_key '...' is a main session with intent='task_assignment' (no-default-to-main forbids)`.

2. **Trigger HR5** (audit): call `sessions_history` from any session. Expect a new line in `<agentId>/peer-contract-enforcer-audit.jsonl` with `kind: "cross_session_query"`.

3. **Trigger HR6** (session-existence): call `sessions_send` with a `target_session_key` that doesn't exist. Expect: BLOCK with reason `target session '...' not found`.

The audit log is the cleanest smoke test — if entries appear with your `agentId` and `correlationId`, the install is working end-to-end.
