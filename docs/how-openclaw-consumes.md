# How OpenClaw Consumes peer-contract v0.1

> **For**: Kelsen, Coder, peer-trial, and any OpenClaw agent that wants to participate in a peer-contract workflow.
> **Author**: Mavis
> **Date**: 2026-08-22 04:10 GMT+8

This doc is the **end-to-end** story of how an OpenClaw agent (any agent, including the existing prod agents) uses peer-contract v0.1 to participate in multi-agent workflows.

## TL;DR

```powershell
# 1. 装 schema (5 份 JSON)
$dst = 'C:\Users\Administrator\.openclaw\protocols\peer-contract'
New-Item -Path $dst -ItemType Directory -Force
Copy-Item -Path 'D:\...\peer-contract-v0.1\spec\*.json' -Destination $dst -Force

# 2. 装 plugin (强制 5 个 runtime HR)
$extDst = 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer'
New-Item -Path $extDst -ItemType Directory -Force
Copy-Item -Path 'D:\...\peer-contract-v0.1\impl\openclaw-plugin\peer-contract-enforcer\*' -Destination $extDst -Recurse -Force
Push-Location $extDst
if (-not (Test-Path 'node_modules')) { npm install }
Pop-Location

# 3. 在 openclaw.json 加 plugin entry
$cfg = 'C:\Users\Administrator\.openclaw\openclaw.json'
$oc = Get-Content $cfg -Raw | ConvertFrom-Json
$oc.plugins.entries.'peer-contract-enforcer' = @{ enabled = $true; path = 'extensions/peer-contract-enforcer' }
$oc | ConvertTo-Json -Depth 10 | Set-Content $cfg

# 4. 重启 OpenClaw
Stop-Process -Name node -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
& 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' gateway
```

**No pollution**: 不动 npm global, 不动 PATH, 不动 Hermes. 唯一动的是 `openclaw.json` + 加 `peer-contract-enforcer/` extension.

## 详细故事

### 角色定义

OpenClaw agent 在 peer-contract v0.1 里可以是 3 种 role 之一:

| Role | 作用 | 限制 |
|---|---|---|
| `main` | 顶层 user-facing session, 接收 task + 派活 | 不能 spawn work sub-session (HR2) — main 派活通过 bus |
| `bus` | 协调层, 任务分配 + 进度跟踪 + yield 路由 | 唯一能在 work session 之间 relay (HR2) |
| `work` | 干活, 单任务, 可 yield | 工具受限 (HR9 6 tools deny), 不能直接 message main (HR1) |

每个 OpenClaw agent **至少 1 个 main + 1 个 bus** 启动时会建. work 是按需 spawn.

### session key 格式

```
agent:<agent-id>:<role>:<context-id>
```

- `agent-id` = `coder` | `kelsen` | `peer-trial` | 自定义
- `role` = `main` | `bus` | `work`
- `context-id` = free string (per-context segmentation)

Examples (real OpenClaw 跑起来后会有):
- `agent:peer-trial:main` — peer-trial 的主 dashboard session
- `agent:peer-trial:bus:dashboard` — peer-trial 的协调 bus
- `agent:peer-trial:work:task-42:primary` — task 42 的 work session (sub-session)

### 完整 dispatch 流程 (multi-agent)

假设 Kelsen (主用户) 想让 peer-trial 干一个 task.

```
1. Kelsen 派活给 peer-trial
   Kelsen 在自己的 dashboard session 调 sessions_send → agent:peer-trial:main
   (这是 Kelsen → peer-trial main, 跨 agent dispatch, plugin 强加 HR1/HR3/HR6)

2. peer-trial main 拆活
   决定需要 spawn 1 个 work session:
   peer-trial main → peer-trial bus (intent: task_assignment, multi_turn.spawn_request)
   peer-trial bus → peer-trial work (intent: task_assignment, multi_turn.spawn_request)
   (plugin 强加 HR2: work 只能由 main 或 bus spawn, 不能 main 直 spawn work via plugin check — wait 实际上 main 可以 spawn work, see schema)

3. peer-trial work 干活
   调 read/write/exec 工具 (HR9 限制), 周期性 yield back to bus
   plugin 在 audit log 写每次 sessions_history/memory_search (HR5)

4. peer-trial work 完成
   multi_turn.lifecycle: completed, AC status: completed
   调 sessions_send → agent:peer-trial:bus (intent: yield_report, yield_status: final)
   plugin 拦 work→main direct (HR1), 只让 work→bus

5. peer-trial bus 转回 main
   bus 收到 yield, 决定 forward 给 main
   bus → main (intent: yield_report, in_reply_to: <work's yield dispatch>)

6. peer-trial main 转发给 Kelsen
   peer-trial main → Kelsen dashboard (in_reply_to: <original dispatch>)
   Kelsen 看到 task 完成, 给老板看
```

**Plugin 在每一步 enforce**:
- HR1: target_session_key 必填, 不默认 main
- HR2: work 只能由 main/bus spawn, work 不能直 work
- HR3: channel-originated → work blocked
- HR5: sessions_history / memory_search → audit log
- HR6: target_session_key 存在 + shape 正确
- HR7: AC accepted_by immutable, ac_chain 不能 extend
- HR9: work toolset 6 tools deny

**Schema 强加** (pre-dispatch):
- HR1: target=main + intent≠inform/query → BLOCK
- HR2: work→work → BLOCK (schema level)
- HR4: payload_self_contained: false 必须 explicit_query + ack
- HR7: ac.accepted_by 一旦 set, 后续 attempts 改这个字段被拒
- HR8: envelope size > 64KB → BLOCK

### agent 写 dispatch 怎么用 CLI

OpenClaw agent (LLM) 写完 envelope 后, 在 dispatch 之前应该跑:

```bash
node 'D:\...\peer-contract-v0.1\impl\cli\bin\peer-contract.js' check my-envelope.json
# exit 0 = OK, exit 1 = BLOCK (error list 输出)
```

CLI 校验的是 schema 层面 (HR1/2/4/7/8). Plugin 校验的是 runtime 层面 (HR1/3/5/6/9). 两者互补.

**For LLM agent**: 把这个 CLI 做成 `peer-contract` skill (Mavis skill system), agent 写完 envelope 自动调, exit ≠ 0 时回修.

### 错误恢复

#### 收到 BLOCK 的 blockReason

Plugin 拒绝 dispatch 时, 会在 error 里返回 blockReason. Example:

```json
{
  "ok": false,
  "blockReason": "HR1: target_session_key: target_session_key 'agent:peer-trial:main' is a main session (no-default-to-main forbids) [main_session_forbidden]"
}
```

LLM agent 应该:
1. Parse blockReason, 提取 HR 编号
2. 看 INSTALL.md 或 docs/ 找对应 HR 的解决方式
3. 修 envelope (改 target_session_key, 改 source_role, 加 cross_session_query_ack, 等)
4. 重发

#### Audit log 出问题

`audit log 路径: $OPENCLAW_HOME/agents/coder/peer-contract-enforcer-audit.jsonl`

```bash
# 看最近 20 行
tail -20 'C:\Users\Administrator\.openclaw\agents\coder\peer-contract-enforcer-audit.jsonl' | jq .
```

每行是 JSON: `{ kind, toolName, sessionKey, targetSessionKey, runId, ts, ... }`

#### Plugin 不工作

```bash
# 1. 看 plugin 状态
& 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' plugins list
# 期望: peer-contract-enforcer 列出, status: enabled

# 2. 看 plugin 启动日志
# OpenClaw gateway 启动时会有 plugin 加载日志
# grep "peer-contract-enforcer" $env:TEMP/openclaw/openclaw-*.log

# 3. Re-run plugin tests 验证 src 完整
cd 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer'
npm test
# 期望: 147 passed, 0 failed
```

如果 tests fail, 可能是 plugin src 被改动. 看 git status (如果 plugin 还在 git repo 里) 或对照 deliverable 重新 copy.

## 卸载 (rollback)

完整反操作. 不留任何 state.

```powershell
# 1. 停 OpenClaw
Get-NetTCPConnection -LocalPort 18789 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Sleep -Seconds 3

# 2. 删 plugin + spec
Remove-Item 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer' -Recurse -Force
Remove-Item 'C:\Users\Administrator\.openclaw\protocols\peer-contract' -Recurse -Force

# 3. 从 openclaw.json 移除 plugin entry
$oc = Get-Content 'C:\Users\Administrator\.openclaw\openclaw.json' -Raw | ConvertFrom-Json
$oc.plugins.entries.'peer-contract-enforcer' = $null
$oc | ConvertTo-Json -Depth 10 | Set-Content 'C:\Users\Administrator\.openclaw\openclaw.json'

# 4. 重启 OpenClaw
& 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' gateway
```

## 多 agent 联合采用

如果想让多个 OpenClaw agent 都用 peer-contract v0.1 (eg. Kelsen + Coder + peer-trial), 各自:

1. 装 schema 到自己的 `~/.openclaw/protocols/peer-contract/`
2. 装 plugin 到自己的 `~/.openclaw/extensions/peer-contract-enforcer/`
3. 改自己的 `~/.openclaw/openclaw.json`

它们互相能 dispatch 是因为 OpenClaw 的 session 寻址是跨 agent 共享的 (session key 格式 `agent:<id>:<role>:<ctx>` 唯一).

不需要 "server-side" 协调 — 协议是 in-band (在 dispatch payload 里), 不需要单独的服务.

## 跟之前 trial work 的关系

之前 (8/19-8/22) trial week 验过的:
- 5/9 HR live-verified (HR1/5/6/9) + 2/9 module-level (HR2/7) + 2/9 not in scope (HR3/4/8)
- 214 tests PASS 在 trial 期间 (含 P0 fixes)

新 deliverable:
- Plugin 5a88234 baseline = 147/147 PASS (含所有 9 HR 的 module-level + live verification framework)
- Schema 5 份 + CLI 4 子命令 + 2 scenarios dry-run-ready
- Plugin src 跟 trial 期间的 P0 fix commit 之前一致 (5a88234)

trial 期间 P0 #1 + #2 (bus sender skip Drift 2/4, bus channel pattern allow) 在 archive 里, Mavis **故意没 apply** 到 v0.1 deliverable. 原因: trial P0 fix 是为了能让 trial topology (有 BUS session 时) 验 HR2/HR7. 真实环境 BUS 拓扑成熟后, P0 fix 可以单独 re-apply. 不在 v0.1 deliverable 里.

---

_OpenClaw consume guide, Mavis, Day 6, 2026-08-22 04:10 GMT+8_
