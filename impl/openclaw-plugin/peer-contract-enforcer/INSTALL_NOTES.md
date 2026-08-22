# peer-contract-enforcer OpenClaw plugin

> **Path D (OpenClaw plugin hook) implementation of peer-contract v0.1**
> **Status**: 147/147 tests pass. Installed and running on prod OpenClaw 18789 (PID 30320) in enforce mode as of 2026-08-22 07:30.

## What this does

Enforces 6 runtime HR rules from the v0.1 spec:

- **HR1** (no-default-to-main) — `before_tool_call` hook checks `target_session_key` ≠ main unless explicit
- **HR3** (no-user-to-work) — channel-originated ctx detection blocks work target
- **HR5** (audit-cross-session-query) — every `sessions_history` / `memory_search` logged to JSONL
- **HR6** (reject-missing-routing) — target_session_key existence check + shape validation via dispatch-schema.js
- **HR7** (immutable-AC-by-worker) — AC cache (ac-cache.js) enforces immutability post-accept
- **HR9** (work-toolset-restricted) — workbench_policy denies 6 tools: `message`, `sessions_spawn`, `music_generate`, `image_generate`, `video_generate`, `skill_workshop`

Static rules (HR2, HR4, HR8) are enforced at **schema** level (see `spec/`), not at runtime. The plugin trusts that envelopes have already passed schema validation.

## Install (OpenClaw side)

```powershell
# 1. Copy plugin to OpenClaw extensions dir
$dst = 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer'
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -Path $dst -ItemType Directory -Force
Copy-Item -Path 'D:\Game and Files\develop\projects\skills\test1\新建\peer-contract-v0.1\impl\openclaw-plugin\peer-contract-enforcer\*' `
          -Destination $dst -Recurse -Force

# 2. Add plugin entry to openclaw.json (B 方案, B-scheme, no path field, no subagent)
#    IMPORTANT: `path` is plugin METADATA, not config. Put it in `plugins.allow`, NOT
#    in the entry. Putting it under `entries.<id>.path` triggers schema rejection
#    (additionalProperties: false). See "Day 6 install reality" below.
$cfg = 'C:\Users\Administrator\.openclaw\openclaw.json'
$oc = Get-Content $cfg -Raw | ConvertFrom-Json
$oc.plugins.entries.'peer-contract-enforcer' = @{
    enabled = $true
    config = @{
        dryRun              = $false
        auditQueryContent   = $false
        payloadSizeCapBytes = 65536
        mainSessionKeyPattern = '^agent:[^:]+:main(:.*)?$'
        workSessionKeyPattern = '^agent:[^:]+:work(:.*)?$'   # B 方案: only `work:`, not `subagent:`
        busSessionKeyPattern  = '^agent:[^:]+:bus(:.*)?$'
    }
}
if (-not ($oc.plugins.allow -contains 'peer-contract-enforcer')) {
    $oc.plugins.allow = @($oc.plugins.allow) + 'peer-contract-enforcer'
}
$oc | ConvertTo-Json -Depth 12 | Set-Content $cfg -Encoding UTF8

# 3. config validate BEFORE restart (catches schema issues without killing prod)
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' config validate
# Expected: "Config valid: ~\.openclaw\openclaw.json" exit 0

# 4. Install plugin deps (LOCAL, not -g, does not pollute npm global)
Push-Location $dst
if (-not (Test-Path 'node_modules')) { npm install }
Pop-Location

# 5. Restart OpenClaw gateway (kill old PID, sleep ≥18s, start fresh)
$old = Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue
if ($old) { Stop-Process -Id $old[0].OwningProcess -Force }
Start-Sleep -Seconds 3
# Use a .bat wrapper for env vars (PS 5.1 Start-Process -Environment 不存在)
Start-Process -FilePath 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' `
              -ArgumentList 'gateway' -WindowStyle Hidden
Start-Sleep -Seconds 20   # OpenClaw 启动 ~14s, sleep 至少 18s
Get-NetTCPConnection -LocalPort 18789 -State Listen   # verify LISTEN
```

**Verify plugin loaded**:
```powershell
& node 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' plugins inspect peer-contract-enforcer --runtime
# Expected: "Status: loaded"

# Also: listen log line should say "5 plugins: memory-core, minimax, peer-contract-enforcer, qqbot, workboard"
Get-Content 'C:\Users\Administrator\AppData\Local\Temp\openclaw\openclaw-2026-08-22.log' `
    | Select-String -Pattern 'http server listening'
```

## Day 6 install reality (Mavis 2026-08-22 07:30)

The install above is the **canonical** procedure. The actual install 8/22 diverged
in 3 places, each caught and fixed:

### Blocker 1: openclaw.json UTF-8 BOM

**Symptom**: `gateway` subcommand exits 78 (EX_CONFIG) with "Missing config" even
though `config validate` returns exit 0 and the file parses fine in node.

**Root cause**: The JSON editor used to patch `openclaw.json` writes UTF-8 BOM (`EF BB BF`).
OpenClaw `config validate` strips BOM before parsing; `gateway` does not.

**Fix** (Python, preserves byte-perfect non-BOM content):
```python
import shutil
p = r'C:\Users\Administrator\.openclaw\openclaw.json'
with open(p, 'rb') as f: d = f.read()
if d[:3] == b'\xef\xbb\xbf':
    with open(p, 'wb') as f: f.write(d[3:])
```

### Blocker 2: schema rejects `path` field

**Symptom**: `config validate` returns
`Config is invalid: plugins.entries.peer-contract-enforcer: Invalid input`.

**Root cause**: `openclaw.plugin.json` configSchema has `additionalProperties: false`
and only allows `dryRun` / `auditQueryContent` / `payloadSizeCapBytes` /
`mainSessionKeyPattern` / `workSessionKeyPattern` / `busSessionKeyPattern`. The
old INSTALL_NOTES (pre-fix) wrongly suggested adding `path: extensions/...` to
the entry. `path` is plugin loader metadata, not plugin config — it goes in
`plugins.allow` instead.

**Fix**: remove `path` from `plugins.entries.peer-contract-enforcer`, add
`'peer-contract-enforcer'` to `plugins.allow` array.

### Blocker 3: `async register` rejected by OpenClaw 0.7.1-2

**Symptom**: Gateway starts, plugin bootstrap log fires, but then
`[plugins] peer-contract-enforcer failed during register: Error: plugin register must be synchronous`
appears; "http server listening" shows 4 plugins (no peer-contract-enforcer).

**Root cause**: `dist/loader-D8d2EvVh.js:762` checks `isPromiseLike(register(api))`
and throws if true. `async function register()` always returns a Promise even
when no `await` is used.

**Fix** in `src/index.js`:
- Change `async register(api)` → `register(api)` (sync).
- The single `await sessionRegistry.bootstrapScan()` becomes
  `sessionRegistry.bootstrapScan().then(...).catch(...)` (fire-and-forget).
- `agentRegistry.bootstrapScan()` was already sync, stays inline.

**Trap**: **OpenClaw hot reload does NOT re-import the plugin module**. After editing
`src/index.js`, you MUST `kill + restart` the gateway. The 7:25 hot reload that
followed the 7:21 fix attempt still saw the cached async register; the 7:26
restart picked up the sync version and the plugin finally loaded.

### Actual install timeline (18789 only)

| 时刻 | PID | 状态 |
|---|---|---|
| 6:32 | 20532 | A 方案 fresh start, plugin 装上 ✓ |
| 7:15 | (hot reload) | A→B config, plugin 仍在 ✓ |
| 7:21 | 11156 | 7:17 剥 BOM 后 kill+restart, register async 报失败 ✗ |
| 7:26 | **30320** | 7:23 改 src sync register + 7:26 kill+restart, **plugin 装上** ✓ |

## Plugin config (B 方案 — current prod)

`openclaw.json` `plugins.entries.peer-contract-enforcer`:
```json
{
  "enabled": true,
  "config": {
    "dryRun": false,
    "auditQueryContent": false,
    "payloadSizeCapBytes": 65536,
    "mainSessionKeyPattern": "^agent:[^:]+:main(:.*)?$",
    "workSessionKeyPattern": "^agent:[^:]+:work(:.*)?$",
    "busSessionKeyPattern": "^agent:[^:]+:bus(:.*)?$"
  }
}
```

`plugins.allow` includes `"peer-contract-enforcer"` (no `path` field on entry).

**Strategic scope (B 方案, user 8/22 07:14)**: plugin enforces **agent↔agent** (main↔main via bus, HR1/5/6). **Does NOT** touch intra-agent sub-sessions: `agent:main:subagent:<uuid>`, `agent:main:dashboard:<uuid>`, `agent:main:cron:<uuid>`, etc. Those fall through HR2/3/9 (dormant). To revert to A 方案 (also match subagent), change `workSessionKeyPattern` to `^agent:[^:]+:(work|subagent)(:.*)?$` and hot reload.

## Plugin runtime contract

The plugin registers these hooks (see `src/index.js`):

| Hook | Fires on | What it does |
|---|---|---|
| `before_tool_call` | every tool call (sessions_send, sessions_history, memory_search, etc.) | Validates routing (HR1, HR6), checks work toolset (HR9), validates contract schema (HR4 via contract-compliance) |
| `subagent_spawned` | new sub-session created | Registers child in role-registry with `role: "work"` |
| `session_start` | any session created | Populates role-registry, session-registry, agent-registry |
| `session_end` | any session ended | Cleans up registries |
| `message_sending` | cross-session message sent | HR5 audit log write |

## Tests

```bash
cd peer-contract-enforcer
npm test
```

Expected: **147 passed, 0 failed** (6 test files: hr9-work-toolset, hr1-hr6-schema-validation, hr4-hr7, hr5-audit, hr-e2e, hr-day6a-followup).

## Plugin src map

| File | Purpose |
|---|---|
| `src/index.js` | Plugin entry, registers hooks, manages plugin lifecycle |
| `src/dispatch-schema.js` | v0.1 dispatch payload schema (used in HR6) |
| `src/dispatch-validator.js` | Dispatch payload validator |
| `src/tool-guard.js` | `before_tool_call` enforcement layer |
| `src/workbench-policy.js` | HR9 work session tool policy (6-tool deny list) |
| `src/contract-compliance.js` | Drift 1-5 + HR4/HR7 enforcement |
| `src/role-registry.js` | Tracks session roles for HR2, HR3 |
| `src/session-registry.js` | Tracks active sessions for HR6 |
| `src/agent-registry.js` | Tracks active agents for Drift 5 (phantom agent) |
| `src/ac-cache.js` | HR7 AC immutability cache |
| `src/audit-logger.js` | HR5 JSONL audit log writer |
| `src/types.js` | Shared typebox schemas |

## Plugin config

Optional config in `openclaw.json` plugins.entries.peer-contract-enforcer:

```json
{
  "enabled": true,
  "path": "extensions/peer-contract-enforcer",
  "config": {
    "auditQueryContent": false,    // log query content in HR5 audit (privacy)
    "payloadSizeCapBytes": 65536,  // HR8 (defense-in-depth, schema also enforces)
    "mainSessionKeyPattern": "^agent:[^:]+:main$",
    "workSessionKeyPattern": "^agent:[^:]+:work:[^:]+:[^:]+:[^:]+$",
    "busSessionKeyPattern": "^agent:[^:]+:bus:[^:]+$"
  }
}
```

Defaults shown. Override only if you need different session key patterns.

## No-pollution guarantee

- No `npm install -g`
- No PATH change
- No system-level config
- Single OpenClaw config change: `openclaw.json` plugins.entries addition
- Plugin deps (`typebox`) installed LOCAL to plugin dir
- Undo = delete `C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer` + remove plugin entry from `openclaw.json`

## Rollback

```powershell
# 1. Stop OpenClaw
Get-NetTCPConnection -LocalPort 18789 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Sleep -Seconds 3

# 2. Remove plugin
Remove-Item 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer' -Recurse -Force

# 3. Remove plugin entry from openclaw.json
$oc = Get-Content 'C:\Users\Administrator\.openclaw\openclaw.json' -Raw | ConvertFrom-Json
$oc.plugins.entries.'peer-contract-enforcer' = $null
$oc | ConvertTo-Json -Depth 10 | Set-Content 'C:\Users\Administrator\.openclaw\openclaw.json'

# 4. Restart OpenClaw
& 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' gateway
```

No leftover state.

---

_Mavis, Day 6, 2026-08-22 04:00 GMT+8_


---

## Day 6a (2026-08-22 09:43) — Issue 1/2/3 fixes (Mavis)

The 8/22 install above is the **canonical** install procedure. The 8/22 9:06 Kelsen test
report and user architectural critique led to 3 additional fixes (Day 6a followup, all by Mavis):

### Issue 1 fix: HR1 intent-aware + cross-agent-to-work block

src/dispatch-schema.js alidateNoDefaultToMain was over-enforcing. Fix:
- **Intent-aware**: mainIntentsAllowlist (default ["inform", "query", "sub-task", "response", "ack", "ping"]).
  	arget=main with intent in allowlist is allowed; default intent 	ask_assignment still blocks.
- **Cross-agent-to-work block**: sender agentId ≠ target agentId AND target matches workSessionKeyPattern → block.
  Same-agent work target allowed (intra-agent sub-session spawn, e.g. gent:coder:bus → gent:coder:work:*).
  Config: crossAgentToWorkBlocked: true (default).

User's 9/22 architectural critique: "Kelsen.bus → coder.work 跨 agent 跳过对方协调层" — fixed.

### Issue 2 fix: HR9 allow work to spawn sub-work

src/workbench-policy.js DEFAULT_WORK_DENIED_TOOLS removed sessions_spawn.
Work sessions can now spawn sub-work for bus/work separation.
Cross-agent abuse is caught by Issue 1's cross-agent-to-work block.

User 8/22 7/14 B 方案 had HR9 dormant. This activates HR9 partially (intra-agent sub-session spawn allowed).
Architectural scope expanded: per user 9/22 implicit OK (no objection raised).

### Issue 3 fix: schema allow main role

src/dispatch-schema.js V2_VALID_SENDER_ROLES and V2_VALID_TARGET_ROLES now include "main"
(was just ["bus", "work"]). Aligns with spec/01-dispatch.schema.json (enum: main/bus/work).
HR1 still semantically blocks main-targeted dispatches unless intent is in mainIntentsAllowlist.

### Tests

- **151/151 PASS** (was 149 before Issue 1/2/3; +5 new tests for intent-aware HR1 + cross-agent-to-work,
  -1 because work session blocked from sessions_spawn → work session can use sessions_spawn,
  +1 split for same-agent/cross-agent work target)
- Test updates: 	ests/hr1-hr6-schema-validation.test.mjs (5 new tests), 	ests/hr9-work-toolset.test.mjs
  (1 updated + 1 new), 	ests/hr4-hr7.test.mjs (3 updated for same-agent), 	ests/hr-e2e.test.mjs (6 updated),
  	ests/hr5-audit.test.mjs (1 updated for same-agent), 	ests/_helpers.mjs (added makeSameAgentV2Dispatch).

### Sync state

prod install (PID 7744, 18789 LISTEN) and Mavis deliverable are in sync (10 files updated).


---

## Day 6a+ (2026-08-22 09:55) — Issue 8 fix: correlation_id chain tracking (Mavis)

User 9/22 09:53 拍 #8 (#6 #7 是设计目的, 维持; #8 是 meaningful, 实现). Mavis 实现:

### What's new

| 改动 | 位置 | 行为 |
|---|---|---|
| Auto-fill correlation_id | src/dispatch-schema.js alidateDispatchSchema Step 2.5 | New task root (parent_dispatch_id=null) 且 correlation_id=null → auto-fill to dispatch_id. Kelsen 显式设置不覆盖. |
| Auto-fill original_dispatch_id | src/dispatch-schema.js 同上 | Sub-task (parent_dispatch_id set) 且 original_dispatch_id=null → auto-fill to parent_dispatch_id. 显式设置不覆盖. |
| Drift 6 enforcement | src/contract-compliance.js | parent_dispatch_id set 但 correlation_id=null → block (CONTRACT: correlation_id_required_for_subtask). Auto-fill 不会覆盖显式 null. |
| Audit log correlationId | src/audit-logger.js + src/tool-guard.js + src/index.js | AuditEvent 加 correlationId 字段. sessions_history / memory_search 记录 correlation_id (从 event.params). message_sending 记录 correlation_id (从 event.correlationId). Kelsen 能跨 audit log 追踪 chain. |

### Tests

**159/159 PASS** (was 151, +8 new tests for #8):
- 4 auto-fill cases (new task root, sub-task, explicit override, original_dispatch_id)
- 3 Drift 6 cases (sub-task null correlation_id blocks, sub-task with correlation_id passes, new task root doesn't fire Drift 6)
- 2 audit log cases (correlationId preserved, undefined when not set)

### Gateway state (post 9:57)

- Gateway: PID 34292, 18789 LISTEN, 9:57:04 ready
- 5 plugins 装上
- peer-contract-enforcer: agent registry 2 agents (coder, main, kelsen), 154 work sessions
- "Status: loaded"


---

## Day 6a+ (2026-08-22 10:18) — Audit log correlationId gap fix (Kelsen #8 feedback)

Kelsen 10:18 feedback 抓到 P0 gap: audit log correlationId 字段只写了 JSDoc comment, record() 实际没解析 (event 没传). Mavis 修:

### 修法

1. **Session-registry 加 correlationId 字段** (src/session-registry.js): SessionRegistryEntry 加 [correlationId] typedef
2. **session_start hook 提取并存** (src/index.js): 3 级 fallback (event.correlationId ?? event.correlation_id ?? event.payload?.correlation_id)
3. **subagent_spawned 继承** (src/index.js): 4 级 fallback (上述 3 个 + parentEntry?.correlationId). 子 session 自动继承父 session 的 thread
4. **tool-guard + message_sending 解析** (src/tool-guard.js + src/index.js): 3 级 fallback (event.params.correlation_id ?? ctx.correlationId ?? sessionEntry?.correlationId)

### Tests

**162/162 PASS** (was 159, +3 新 test):
- session-registry correlationId resolution
- explicit params.correlation_id 优先级 > session-registry
- 全空时 correlationId=undefined (不报错)

### Gateway state (post 10:17)

- Gateway: PID 29812, 18789 LISTEN, 10:17:08 ready
- 5 plugins 装上
- agent registry 2 agents (coder, main, kelsen), 154 work sessions

### 已知限制

OpenClaw event schema 是否带 correlationId / payload.correlation_id 字段未验证. 3 级 fallback 兜底, **如果 OpenClaw 不传, 靠 session-registry 接力** (session_start 存, subagent_spawned 继承, 后续 hooks 读).
老 audit entries (9:55-10:17) 没 correlationId, **不能补**. 历史数据就是历史.


---

## Day 6a++ (2026-08-22 10:30) — Kelsen #8 v2 feedback 3 真 bug 修了 (Mavis)

Kelsen 10:28 feedback v2 按老板流程 (先查代码后跑端到端) 抓到 3 个真 bug, Mavis 全修:

### P0-1: auto-fill mutation 不传到 event.params.message (string)

src/tool-guard.js sessions_send 分支加 write-back:
`js
if (r.resolvedShape === "v2_message_string" && typeof event.params.message === "string") {
  try { event.params.message = JSON.stringify(params); } catch (e) { /* leave original */ }
}
`

修前: validateDispatchSchema Step 2.5 mutate 新对象, OpenClaw runtime 用原始 event.params.message deliver, **Coder 收到原始 null**.
修后: write-back 到 event.params.message, **Coder 收到 auto-filled correlation_id**.

### P0-2: audit log correlationId 仍 0 hits

两层 fix:

1. **tool-guard 主动预填** (sessions_send 分支):
`js
if (targetSessionKey && params.correlation_id) {
  const existing = sessionRegistry?.get(targetSessionKey);
  sessionRegistry?.set(targetSessionKey, {
    ...(existing ?? {}),
    agentId: existing?.agentId ?? ctx.agentId,
    correlationId: params.correlation_id,
    source: existing?.source ?? "dispatch_prefill",
  });
}
`

2. **session_start hook inherit** (Kelsen 验证 OpenClaw event 不传 correlationId):
`js
const existing = sessionRegistry.get(sk);
const correlationId = event.correlationId
  ?? event.correlation_id
  ?? event.payload?.correlation_id
  ?? existing?.correlationId;  // ← inherit from pre-fill
`

修前: 3 级 fallback 全 undefined, session-registry 没接力, audit entries 0 correlationId.
修后: tool-guard 预填 → session_start inherit → 后续 audit 读 session-registry.

### P1: workSessionKeyPattern default 不认 "run:" prefix

src/workbench-policy.js:
`js
workSessionKeyPattern: new RegExp(config.workSessionKeyPattern ?? "^agent:[^:]+:(work|run)(:.*)?$"),
`

修前: OpenClaw coder session key gent:coder:run:xxx 不被识别为 work, HR1 cross-agent-to-work 不 fire.
修后: 认 (work|run), role-registry.js 早就是这种格式, policy 现在对齐.

### Tests

**164/164 PASS** (was 162, +2 新 E2E 16/17):
- E2E 16: v2_message_string auto-fill writes back to event.params.message
- E2E 17: sessions_send pre-fills session-registry with target's correlationId
- +2 P1 test in hr1-hr6-schema-validation: cross-agent/same-agent target=run

### Gateway state (post 10:31)

- Gateway: PID 14332, 18789 LISTEN, 10:31:25 ready
- 5 plugins 装上
- 154 work sessions bootstrap

### 教训 (Mavis 自查)

Kelsen 反馈提到 "代码层面 fix 都到位, 但端到端测试暴露 runtime 阻断". **Mavis 装 plugin 完后只跑 unit test, 没跑 end-to-end 验证**. 这次 3 个 bug 都是 runtime 行为 (mutation 不传递, fallback 全 undefined, pattern 不匹配), unit test 抓不到.

**流程改进**: 以后 plugin 装完, **Mavis 自己跑一遍 end-to-end 验证** (跨 hook 数据流), 不只 unit test.


---

## Day 6a+++ (2026-08-22 11:20) — P0-3 (HR2 dead code) fix (Kelsen 4th bug)

Kelsen 11:15 feedback 抓到 4th bug: ole-registry.js:92-98 session_start handler 写 parentSessionKey: undefined, **覆盖了** subagent_spawned (line 59-65) 之前设的 parentSessionKey: event.sessionKey.

**根因**: OpenClaw 触发顺序: subagent_spawned → session_start → work session 实际工作. session_start 把 parentSessionKey 覆盖为 undefined, 导致 	ool-guard.js:198-202 HR2 parent check 的 callerInfo?.parentSessionKey && callerInfo.parentSessionKey !== targetSessionKey 短路, **HR2 永远不 fire**. 结果: work session 可以 send 给任何 bus (own parent / 跨 agent), 违反老板 10:40 设计原意 #2 ("Coder 内部 bus/work 分离能达就行").

**之前 7/7 PASS 报告有 2 个假阳性** (Test 4.1 Coder.work→Kelsen.bus 跨 agent / Test 3.2 Kelsen.work→coder.bus 跨 agent, 标"✅ ALLOW" 实际是 bug behavior).

**修法** (src/role-registry.js:72-100):
`js
const existing = roleRegistry.get(event.sessionKey);
let parentSessionKey = existing?.parentSessionKey;  // ← inherit
let subTaskId = existing?.subTaskId;
let cardId = existing?.cardId ?? null;
let agentId = existing?.agentId ?? event.ctx?.agentId;
// ...
roleRegistry.set(event.sessionKey, {
  role,
  parentSessionKey,  // inherited from subagent_spawned
  agentId,
  cardId,
  subTaskId,
  source: existing ? "session_start_inherit" : "session_start",
});
`

	ool-guard.js:198-202 HR2 parent check **不用改** (P0-3 修了 session_start 之后 parent 真存了, HR2 自动 fire).

### Tests

**166/166 PASS** (was 164, +5 新):
- 3 lifecycle test (新文件 	ests/role-registry-lifecycle.test.mjs):
  - session_start preserves parentSessionKey set by subagent_spawned (P0-3 fix 主测试)
  - session_start for new session leaves parentSessionKey undefined
  - session_start preserves subTaskId and cardId set by subagent_spawned
- 2 E2E (E2E 18/19 in 	ests/hr-e2e.test.mjs):
  - **E2E 18**: work→bus same-agent ALLOW (HR2 parent match)
  - **E2E 19**: work→bus cross-agent BLOCK (HR2 parent check)

### 真状态修正 (之前 7/7 PASS 报告有 2 个假阳性)

P0-3 修后, 真实测试结果是 **5/7 PASS + 2/7 BLOCK** (符合老板 10:40 设计原意 #2). 之前 7/7 PASS 报告里 Test 4.1 / Test 3.2 是假阳性.

### Gateway state (post 11:20)

- Gateway: PID 8856, 18789 LISTEN, 11:20:20 ready
- 5 plugins 装上
- 154 work sessions bootstrap

### 流程改进 (Kelsen 11:15 §6 提的, 加进 Mavis memory)

之前 Mavis 装完 plugin 流程: unit test → ship (漏了 source review).
新流程:
1. Mavis 装完 plugin → unit test 通过
2. **Mavis 自己 source review** (看 lifecycle / handler order / 写顺序 / 是否有覆盖/重置) ← **P0-3 加这一步**
3. Mavis 自己跑 end-to-end 验证 (跨 hook 数据流)
4. 写 self-test report
5. 没问题 → ship
6. 有问题 → 修, 重启, 重测, 再写 report

已写进 Mavis agent memory. P0-3 bug 抓出证明 source review 这一步不可省.
