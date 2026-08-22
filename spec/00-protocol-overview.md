# peer-contract v0.1 — Protocol Overview

> **Status**: v0.1 (Day 5 deliverable, 2026-08-22)
> **Author**: Mavis (接手 Kelsen + Coder 跑过的 trial week 后从零写)
> **Scope**: agent-to-agent 通信协议通用模板，4 个核心问题的 schema 化解决方案

---

## 0. 为什么有这套协议（背景）

老板 (Hulker309) 跟 Kelsen 在 8/18 4:01 立项：让 agent 和 agent 之间的对话协议细化。8/19 16:41 定调 "这是一个通用的，我的想法是这将会是一个通用的契约层模板"。

8/19-8/22 Kelsen + Coder 跑 trial week 验过 v0.1 plugin (Path D, OpenClaw plugin hook)，Day 1-3 OK, Day 4 暴露问题：

- 9 HR rules 写得很全，但 **defense-in-depth 顺序** (HR6 → HR1 → HR2, HR1 → HR7) 让 HR2/HR7 在 trial topology 不可达
- **acCache 只由 BUS-role populate**, trial 无 BUS session → HR7 永远 live 不可达
- 用户决定完全绕开 OpenClaw 重做, 由 Mavis 直接生产 deliverable, OpenClaw 之后作为测试消费者安装/使用

**4 个核心问题**（这是 user 8/18 原话拆出来的, 任何 enforce 形式都要解决这 4 个）:

1. **显式路由** — dispatch 必须显式 `target_session_key`, 不能默认往 main 塞
2. **session 隔离** — SA1/SA2 同 agent 但不同 session, 上下文隔离
3. **multi-turn 协作** — sub-session 多轮 + AC chain 完整
4. **bus 协作机制** — 任务分配 + 进度同步, bus 不是简单 message queue

## 1. 4 个核心问题 → 4 份 schema

| 问题 | Schema | 关键字段 |
|---|---|---|
| 显式路由 | `01-dispatch.schema.json` | `target_session_key` (必填, regex 校验), `dispatch_id` (UUID), `source_role`, `target_role` |
| session 隔离 | `02-isolation.schema.json` | `context_scope` (self/explicit_query), `payload_self_contained`, `cross_session_query_ack` |
| multi-turn 协作 | `03-multi-turn.schema.json` | `sub_session_request`, `acceptance_criteria`, `ac_chain`, `yield_pattern` |
| bus 协作 | `04-bus.schema.json` | `task_assignment`, `progress_sync`, `expected_yield`, `bus_session_required` |
| **envelope (总)** | `99-envelope.schema.json` | 上面 4 个 + 通用 metadata (timestamp, sender, version) |

**envelope = 单条消息的完整格式**, 4 个 component = 各自独立可用的 sub-schema。任何 platform 拿 envelope schema 就能知道"什么是合规的 dispatch"。

## 2. 协议核心约定

### 2.1 Session Key 格式
```
agent:<agent-id>:<role>:<context-id>
```
- `agent-id`: agent 名 (e.g. `coder`, `kelsen`, `peer-trial`)
- `role`: `main` | `bus` | `work`
- `context-id`: 自由字符串, 但要跟 OpenClaw sessionKind segment 区分 (e.g. `webchat`, `subagent`, `dashboard`, `tui`, `run` 是 reserved, 见 `session-registry.js` 早先约定)

**正则**:
```
^agent:[^:]+:(main|bus|work):[^:]+(:[^:]+)*$
```

### 2.2 9 条硬规则 → enforcement 形式分流

| 规则 | 抓的时机 | 形式 |
|---|---|---|
| HR1 no-default-to-main | runtime | plugin `before_tool_call` hook + dispatch schema 强制 `target_session_key` 必填 |
| HR2 no-cross-work-direct | static | schema 强制 `source_role=work` 时 `target_role=bus` (not work) |
| HR3 no-user-to-work | runtime | channel-originated ctx 检测 (plugin 注入 `messageProvider` 字段) |
| HR4 payload-self-contained | static | schema 强制 `payload_self_contained: true`, 不允许 `need_lookup` 引用 |
| HR5 audit-cross-session-query | runtime | audit log 强制写 (plugin hook) |
| HR6 reject-missing-routing | runtime | `target_session_key` 必填 + 在 role registry 查得到 |
| HR7 immutable-ac-by-worker | runtime + static | ac schema 强制 `accepted_by` immutable, worker 不能 extend `ac_chain` |
| HR8 payload-size-cap | static | envelope 强制 `body` size ≤ 64KB |
| HR9 work-toolset-restricted | runtime | plugin 强制 work session tool list 限制 (6 工具 deny list) |

**为什么这么分流**: runtime rules 需要"运行时上下文" (channel / target 存在性 / caller role), static rules 是"模式/形状"判断, 任何 platform 都能做。

### 2.3 Schema 是数据, 不是代码

每份 schema 都是 **JSON Schema Draft 2020-12** 格式, 纯数据, 不依赖任何 runtime library。任何 platform 拿这个 JSON 就能:
- 读 spec 知道协议长什么样
- 写 validator 校验消息
- 写 linter 静态检查
- 写 simulator dry-run 模拟

**零依赖, 零 vendor lock-in**。

## 3. 跟 OpenClaw runtime 的关系

OpenClaw 吃 runtime 形式 (HR1, HR3, HR5, HR6, HR7 部分, HR9)。其他 platform 吃 static 形式 (HR2, HR4, HR7 部分, HR8)。

具体到 v0.1 deliverable:
- `spec/*.json` — 公开 spec, 任何 platform 都能读
- `impl/cli/peer-contract.js` — 跨平台 CLI, 任何机器能跑 (零依赖)
- `impl/openclaw-plugin/` — OpenClaw 平台 binding, 装到 `~/.openclaw/extensions/` 后吃 schema + 做 runtime enforcement
- `scenarios/*.yaml` — dry-run 场景, 用 CLI 跑

**OpenClaw install 不污染其他软件** (无 `npm install -g`, 无 PATH 改, 仅改 `openclaw.json` 加 1 个 plugin entry)。

## 4. 端到端 flow

```
1. A 在 SA1 想给 B 发任务
2. A 写 envelope (按 99-envelope.schema.json: dispatch + isolation + multi-turn + bus 都填)
3. A 调 `peer-contract check <envelope>` → OK / BLOCK:HR6:target_not_in_registry
4. A 调 `sessions_send` (OpenClaw tool) → plugin before_tool_call hook 二次检查 (HR1, HR6)
5. B 在 SB1 收到
6. B 想开 SB2 干活 → B 写 sub_session_request (multi-turn schema)
7. B 调 `peer-contract check` → OK
8. B 调 `sessions_spawn` → 创建 SB2 (work session, 受 HR9 限制工具集)
9. SB2 干完, 生成 AC (acceptance_criteria per multi-turn schema)
10. SB2 调 `peer-contract ac-chain <card_id>` → 检查 chain 完整性
11. SB2 调 `sessions_send` → 回 B 的 bus (per bus schema)
12. B 在 bus 看到 AC, 转发给 SA1 (per isolation 规则)
13. A 收到 AC, accept, AC chain immutable (HR7 拦后续改)
```

## 5. 用法

**读 spec**: 看 `01-04 + 99-envelope.schema.json` 5 份, 知道协议长什么样

**写代码**:
- Agent 写 dispatch 之前调 `peer-contract check <envelope>` 自检
- OpenClaw 装 plugin 之后, sessions_send 等工具自动被 plugin 二次 enforce

**测场景**:
```bash
node impl/cli/bin/peer-contract.js dry-run scenarios/02-multi-turn-ac-chain.yaml
# 不真发, 模拟全链路, 返回每步 OK / BLOCK
```

**rollback**:
- 反向操作, 复制移走, 删 openclaw.json plugin entry 即可
- 不会留下 npm global 残留

## 6. 跟之前 trial work 的关系

之前 (8/19-8/22 Kelsen + Coder 跑 trial week) 留下:
- `archive/plugin-src-pre-project-revert/` — 完整 plugin src snapshot (含 trial 期 5a88234 commit 状态)
- `archive/plugin-src-before-revert/` — 第一轮 revert 前 snapshot
- 5 个 coder session JSONL — 在 `~/.openclaw/agents/coder/sessions/`, OpenClaw 自己 retention 处理
- 2 份 trial week state doc — 在 `~/Desktop/archive/trial-week-2026-08-22/`

新 v0.1 deliverable 完全独立, 不依赖 trial 残留。如果 user 想参考 trial 期间的 P0 #1 + #2 fix (bus sender skip Drift 2/4 + bus channel pattern allow), 见 archive 里 8/22 03:00 之前的 src 备份。

## 7. 公开 spec vs 内部 Skill

- `spec/*.json` — **公开**, 任何 platform 读
- `docs/*.md` — **公开**, 模式解释
- 不写 Skill — Skill 绑 Mavis 平台, 反通用

---

_写于 2026-08-22 03:25 GMT+8 by Mavis, Day 5 deliverable_
