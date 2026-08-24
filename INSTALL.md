# peer-contract v0.1 — INSTALL

> Verified install procedure for OpenClaw 0.7.1+ on Windows + PowerShell 5.1.
> Author: Mavis (peer agent)  |  Last verified: 2026-08-24 08:35 GMT+8 (Day 8)

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
        # Day 8 (2026-08-24): HR5.1 bus-context-required. Default true.
        # Bus target_session_key MUST include a context-id segment; bare
        # `agent:<id>:bus` (no context) BLOCKED. Set false only for an
        # explicit shared-inbox design.
        busContextRequired      = $true
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
| `before_tool_call` | every tool call | Validates `sessions_send` envelopes against v0.1 schema + HR1/HR2/HR3/HR4/HR5.1/HR6/HR7/HR8/HR9 rules. Blocks with structured `blockReason` on violation. |
| `subagent_spawned` | new sub-session created | Registers the child session as a "work" role with `parentSessionKey` pointing to the dispatcher. |
| `session_start` | any session opens | Populates role-registry, session-registry, agent-registry, with **inheritance from any pre-existing entry** (so `parentSessionKey` set by `subagent_spawned` survives). |
| `session_end` | any session closes | Cleans up registries. |
| `message_sending` | cross-session message | Appends to per-agent audit log (`peer-contract-enforcer-audit.jsonl`). |

The full install record (3 blockers fixed, 8 fix iterations, 4 end-to-end bug rounds) is in `impl/openclaw-plugin/peer-contract-enforcer/INSTALL_NOTES.md`.

## Day 8 followup (2026-08-24) — install workflow tightened

Mavis 8/24 08:10 took a Kelsen 4-agent bootstrap install at face value during pre-flight + restart + verify, and only caught a spec simplification (bare `agent:<id>:bus` instead of `agent:<id>:bus:<context>`) when the user asked why bus collapses to a shared inbox. The plugin + tests already enforced per-context bus — the bootstrap was the one that didn't follow the spec, and Mavis missed it during install.

**New install workflow** (apply this for any plugin install or agent-bootstrap handoff, not just peer-contract-enforcer):

1. Pre-flight (config validate, file presence, JSON valid).
2. **Source review** — read the spec the install is supposed to implement (e.g. `docs/bus-coordination.md` for bus, `docs/architecture.md` for the whole thing). Diff the install's bootstrap/dispatch code against the spec. Flag any simplification, missing flow, or default that contradicts the spec.
3. Restart gateway.
4. End-to-end verify (cross-hook data flow, not just unit tests).
5. Self-test report (what PASS, what FAIL, what skipped).
6. Rollback on any FAIL.

**Spec entry points** for diffing:

| Concern | Spec file |
|---|---|
| Bus coordination semantics + key shape | `docs/bus-coordination.md` |
| Architecture + role model | `docs/architecture.md` |
| Multi-turn patterns | `docs/multi-turn-patterns.md` |
| Common plugin/agent pitfalls | `docs/common-blocks-and-fix.md` |
| What is and isn't enforced | `docs/known-limitations.md` |
| v0.1 §2.2 wire format | `spec/99-envelope.schema.json` + `spec/01-04-*.json` |

When a bootstrap deviates from spec, **do not declare "loaded"**. Either fix the bootstrap, or escalate back to the bootstrap author (e.g. Kelsen) before resuming the install.

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

## Day 8 v2 followup (2026-08-24) — workboard 集成

**老板 10:50 提示**: peer-contract-enforcer 不应该自己造 task state — OpenClaw workboard 已经是 task lifecycle 的 source-of-truth。

**Day 8 v2 设计变更**：
- **HR10 (parent_task_id 校验)**: 之前 8/22 Day 8 v1 计划自己造 in-memory task-registry 跟踪 task 状态。**Day 8 v2 改为 schema-only 校验** —— `parent_task_id` 必是 UUID 格式（跟 workboard card_id 一致）。实际 dependency-graph 状态 enforce 由 workboard 的 `linkCards` + `promoteReady` private method 做。
- **Task 生命周期不归 plugin 管** —— workboard 的 `done` / `running` / `blocked` / `todo` 等 status 是 source-of-truth。Plugin 不再调 updateState 推断。
- **HR5.1 multi-target (Day 8 v2 新增)**: `target_session_keys` 数组（替代或补充 `target_session_key`）。每个 entry 必带 per-context bus id（与单 target HR5.1 一致）。Plugin 验证 schema，实际 fan-out 是 caller's 责任（业务层调 N 次 sessions_send）。

**Wire format 变更**（spec/01-dispatch + 04-bus）：
- `parent_task_id`: 新加 optional 字段，UUID format（workboard card id）
- `target_session_keys`: 新加 optional 数组（multi-target broadcast），与 `target_session_key` 互斥
- `04-bus.broadcast.scope` 加 `explicit_target_session_keys` enum + `multi_target_session_keys` 数组字段

**Plugin 变更**（4 个 src 文件）：
- `src/dispatch-schema.js`:
  - `validateTaskDependency(parentTaskId)`: 改 schema-only (UUID format), 删 task-registry 依赖
  - 新加 `validateMultiTargetBusContext(targetSessionKeys)`: 扩展 HR5.1 到数组
  - `validateDispatchSchema` Step 5.2 / 5.3: 调新 validator
- `src/tool-guard.js`:
  - 删 task-registry 创建 (Day 8 v1 中间版, 改 Day 8 v2 删了)
  - 删 yield_report / task_assignment 的 state update (workboard 自己做)
- `src/index.js`:
  - 删 `createTaskRegistry()` 创建 (跟 tool-guard 解耦)

**Test 变更**:
- 删 `tests/hr10-multi-target.test.mjs` (Day 8 v1 in-memory registry 版)
- 新加 `tests/hr10-uuid-multitarget.test.mjs` (Day 8 v2 schema-only + multi-target)
- 23 个新 test, 全 PASS; 全量 166/166 PASS

**为什么这设计**:
- **避免重复造轮子**: workboard 已经有 `taskId` / `linkCards` / `promoteReady` / `WORKBOARD_LINK_TYPES: ["parent", "child", "blocks", "blocked_by"]`，plugin 再造 task-registry 是 redundant。
- **边界明确**: peer-contract-enforcer = message-shape enforcement; workboard = task-state tracking。两者通过 workboard card_id 协作，no overlap。
- **leaner**: 删了 50 行 task-registry.js + 几十行 yield_report update 逻辑，plugin 代码更少。

**业务层调用 pattern**（参见 4 agent AGENTS.md §6 "workboard 集成"）:
```js
// 1. 建 workboard card
const card = await workboard.createCard({ title: "...", agentId: "modeler", status: "ready" });

// 2. (可选) 建 dependency edge
if (upstreamCardId) {
  await workboard.linkCards(upstreamCardId, card.id);
  // ↑ workboard 自动等 upstream 到 "done" 才 dispatch child
}

// 3. envelope 带 parent_task_id (workboard card id, 不是 "task-42" 之类)
sessions_send(..., message={ bus: { task_assignment: { parent_task_id: upstreamCardId, ... } } });
// plugin HR10: 验 UUID format ✓
// workboard dispatch: 验 upstream 状态, 不到 done 则 block ✓
```

**如何 verify Day 8 v2**:
```powershell
# HR10 schema check: parent_task_id = non-UUID → BLOCK
# HR10 schema check: parent_task_id = valid UUID → ALLOW
# HR5.1 multi: target_session_keys 数组含 bare bus key → BLOCK that one

cd C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer
node tests\_run-all.js
# Expect: Total OK Passed: 189 (166 prior + 23 new), Total FAIL Failed: 0
```
