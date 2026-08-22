# Day 6 — OpenClaw Plugin + E2E Validation Report

> **写于**: 2026-08-22 04:15 GMT+8 (Mavis)
> **trial**: `D:\Game and Files\develop\projects\skills\test1\新建\peer-contract-v0.1\` (Mavis 全新工作区)
> **prod**: 0 触动 verified
> **scope**: Day 5 spec + CLI + scenarios + Day 6 OpenClaw plugin
> **plugin src baseline**: 5a88234 (peer-contract-enforcer pre-HR5-fix + Day 6a followup)
> **plugin test result**: 147/147 PASS, 0 FAIL

---

## Pre-flight

| Item | Value |
|---|---|
| **plugin src** | `C:\Users\Administrator\.openclaw\agents\coder\plugins\peer-contract-enforcer\src\` (12 .js files) |
| **plugin tests** | `C:\Users\Administrator\.openclaw\agents\coder\plugins\peer-contract-enforcer\tests\` (10 .mjs files) |
| **plugin HEAD** | `5a88234 baseline: peer-contract-enforcer pre-HR5-fix` (only commit) |
| **plugin dependencies** | `typebox` 1.3.3 (1 package, no devDeps) |
| **plugin runtime** | OpenClaw 2026.7.1+ (peer dep) |
| **deliverable target** | `D:\Game and Files\develop\projects\skills\test1\新建\peer-contract-v0.1\impl\openclaw-plugin\peer-contract-enforcer\` |
| **prod openclaw.json SHA256** | `21EC27C985918224036855C91DFD1329E11AF80F1BE48CC79C5F104F9665DB4A` (= baseline, 0 触动) |
| **prod gateway 18789** | LISTEN PID 23680 (binary: `C:\Users\...\npm\node_modules\openclaw\openclaw.mjs gateway`, prod binary) |
| **trial 19001** | DEAD (reverted 8/22) |
| **5 coder session JSONL** | 保持不变 (read-only audit trail) |
| **active main session 1c4363fa-...** | 保持不变 (1907884 B, 8/22 01:34:57) |

---

## 1. Plugin 在 deliverable 位置跑通 (147/147 PASS)

| Test file | Pass | Notes |
|---|---:|---|
| hr9-work-toolset.test.mjs | 26 | HR9 deny list (6 tools: message, sessions_spawn, music_generate, image_generate, video_generate, skill_workshop) |
| hr1-hr6-schema-validation.test.mjs | 55 | v0.1 dispatch schema shape validation (HR1, HR6) |
| hr4-hr7.test.mjs | 29 | HR4 (payload self-contained) + HR7 (AC immutable) |
| hr5-audit.test.mjs | 17 | HR5 audit logger (JSONL write, cross_session_query) |
| hr-e2e.test.mjs | 15 | End-to-end: bus → work → AC modify → audit log |
| hr-day6a-followup.test.mjs | 5 | Drift 5 ref holds (RESERVED_SESSION_KINDS blacklist) |
| **TOTAL** | **147** | **0 regression vs 5a88234** |

**为什么从 214 降回 147**: Trial 期间 (8/21) 加了 `p0-day3-followup.test.mjs` (15 tests) + `contract-compliance-v2.test.mjs` (~52 tests), 加 P0 #1 + #2 fix 让 trial topology (含 BUS session) 能验 HR2/HR7. 5a88234 baseline 是 revert 到 P0 fix 之前的状态. v0.1 deliverable 故意不带 P0 fix — 老板 8/22 说"完全绕开 OpenClaw 重做", P0 fix 是 trial 期间的 implementation detail, 不是 v0.1 spec 的一部分.

如果 trial P0 fix 后面要 re-apply, 看 `archive/plugin-src-pre-project-revert/` 里的备份 + 之前 trial week state doc 的 P0 行数描述.

---

## 2. Spec 跟 Plugin src 的 mapping

| Spec schema | Plugin src | 强加的 HR |
|---|---|---|
| `01-dispatch.schema.json` | `src/dispatch-schema.js` + `src/dispatch-validator.js` | HR1 (target session_key), HR2 (source→target role), HR6 (existence) |
| `02-isolation.schema.json` | `src/contract-compliance.js` | HR4 (payload self-contained), HR5 (cross-session audit) |
| `03-multi-turn.schema.json` | `src/contract-compliance.js` + `src/ac-cache.js` | HR7 (AC immutable post-accept) |
| `04-bus.schema.json` | (enforced at bus session logic, not in plugin) | (bus coordination pattern, see bus-coordination.md) |
| `99-envelope.schema.json` | (composite of above) | (whole wire format) |

Plugin runtime enforce (in `src/tool-guard.js`, `src/workbench-policy.js`, `src/contract-compliance.js`):
- HR1, HR3, HR5, HR6, HR7, HR9

Schema 强加 (in `*.json` files via CLI `check` command):
- HR1 (also), HR2, HR4, HR7 (also), HR8

**重叠**: HR1, HR7 — both layers enforce (defense in depth, 任何一层漏不致命)
**Schema-only**: HR2 (work→work blocked by shape, no runtime detection needed), HR4 (payload self-contained is shape check), HR8 (size is shape check)
**Runtime-only**: HR3 (channel-originated ctx needs runtime detection), HR5 (audit log is runtime event), HR6 (target existence needs runtime check), HR9 (work toolset is runtime policy)

---

## 3. CLI smoke test (Day 5 deliverable, Day 6 re-verify)

| Command | Expected | Actual |
|---|---|---|
| `peer-contract --version` | `peer-contract 0.1.0` | ✅ |
| `peer-contract check <ok-envelope>` | OK + size | ✅ (1153 B / 65536) |
| `peer-contract check <hr1-bad-envelope>` | BLOCK + HR1 message | ✅ |
| `peer-contract validate-schema <env> <99-envelope.schema>` | OK | ✅ |
| `peer-contract ac-chain list / append / verify` | works | ✅ |
| `peer-contract dry-run 01-basic-dispatch.yaml --reset-state` | 6/6 OK | ✅ |
| `peer-contract dry-run 02-multi-turn-ac-chain.yaml --reset-state` | 5 OK + 2 BLOCK (HR7, HR9) | ✅ |

---

## 4. OpenClaw plugin install (Day 6 ready, not auto-installed)

```powershell
# 装 schema
$dst = 'C:\Users\Administrator\.openclaw\protocols\peer-contract'
New-Item -Path $dst -ItemType Directory -Force
Copy-Item -Path 'D:\...\peer-contract-v0.1\spec\*.json' -Destination $dst -Force

# 装 plugin
$extDst = 'C:\Users\Administrator\.openclaw\extensions\peer-contract-enforcer'
New-Item -Path $extDst -ItemType Directory -Force
Copy-Item -Path 'D:\...\peer-contract-v0.1\impl\openclaw-plugin\peer-contract-enforcer\*' -Destination $extDst -Recurse -Force
Push-Location $extDst
if (-not (Test-Path 'node_modules')) { npm install }  # LOCAL, no -g
Pop-Location

# 加 plugin entry
$cfg = 'C:\Users\Administrator\.openclaw\openclaw.json'
$oc = Get-Content $cfg -Raw | ConvertFrom-Json
$oc.plugins.entries.'peer-contract-enforcer' = @{ enabled = $true; path = 'extensions/peer-contract-enforcer' }
$oc | ConvertTo-Json -Depth 10 | Set-Content $cfg

# 重启 OpenClaw (npm global binary, NOT trial)
Stop-Process -Name node -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
& 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' gateway
```

**这一步我没自动跑** — 重启 OpenClaw 是高影响操作 (停所有 node, 18789 短暂 down). 老板 (你) 决定什么时候装. 详细在 `INSTALL.md` (主) + `impl/openclaw-plugin/peer-contract-enforcer/INSTALL_NOTES.md` (plugin 详细).

---

## 5. E2E validation status (Day 6 部分)

| Check | Status |
|---|---|
| Plugin src 完整 (12 .js files) | ✅ |
| Plugin tests 在 deliverable 位置跑通 (147/147) | ✅ |
| Plugin manifest 正确 (`openclaw.plugin.json` declares `id: peer-contract-enforcer`) | ✅ |
| Plugin entry 正确 (`package.json` declares `openclaw.extensions: ["./src/index.js"]`) | ✅ |
| Plugin deps (typebox 1.3.3) installable local (no -g) | ✅ |
| Schema 5 份 (JSON Schema Draft 2020-12) 完整 | ✅ |
| CLI 4 子命令 (check / validate-schema / ac-chain / dry-run) 跑通 | ✅ |
| 2 份 scenarios dry-run 通过 | ✅ |
| INSTALL.md (主, 零污染) | ✅ |
| docs/multi-turn-patterns.md | ✅ |
| docs/bus-coordination.md | ✅ |
| docs/how-openclaw-consumes.md | ✅ |
| 端到端 plugin 装到 OpenClaw + 跑真场景 | ⏳ **没做** (要你拍: 装不装) |

---

## 6. 已知 limitations (v0.1)

1. **P0 fix (bus sender skip Drift 2/4) 没 apply** — 5a88234 baseline 状态. trial 期间验证过, 现在不在 v0.1. 如果未来要 re-apply, 见 archive backup.
2. **HR2 / HR7 live verification 需要 BUS 拓扑** — defense-in-depth 顺序 + acCache-only-by-BUS 限制让这两个 rule 在 trial 不可达. v0.1 deliverable 用 "module-level + unit test coverage" 代替. 真实生产环境, BUS 拓扑成熟后, HR2/HR7 live verification 可以单独做.
3. **CLI 的 mini YAML parser 只支持子集** — 复杂 YAML (anchors, multi-doc, block scalars) 不支持. 我们 scenarios 用的语法都支持.
4. **AC state 在 user-level** (`%APPDATA%\peer-contract\ac-chain.json`) — 跨 OS 同步需要手动. 不在 spec, 只是 CLI 实现选择.
5. **Plugin 端没自检** — `peer-contract check` 是 CLI 工具, agent 写完 envelope 后要主动调. 没做成 OpenClaw tool 注册 (Day 7 再说).

---

## 7. 7-point verification (Day 6 cumulative)

| # | Verification | Result |
|---|---|---|
| **1** | Day 5 spec/CLI/scenarios 完整 (per smoke test 3) | ✅ |
| **2** | Day 6 OpenClaw plugin src 完整 (12 files copied) | ✅ |
| **3** | Plugin tests 在 deliverable 位置跑通 (147/147) | ✅ |
| **4** | Plugin manifest + entry 正确 (OpenClaw 能 load) | ✅ |
| **5** | Plugin deps installable local (no npm global pollution) | ✅ |
| **6** | INSTALL.md + INSTALL_NOTES.md + docs/ 完整 (5 文件) | ✅ |
| **7** | prod 0 触动 (openclaw.json SHA256 unchanged, 18789 PID 23680 alive) | ✅ |

---

## 8. 给老板的 next-step 选项

| 选项 | 说明 | 时间 | 风险 |
|---|---|---|---|
| A. 装 + 跑真场景 (Day 7 准备) | 用 `INSTALL.md` 装 OpenClaw plugin, 跑 Kelsen→peer-trial 真实 multi-agent dispatch, 收集真场景的 audit log + AC chain, 准备 Day 7 决策包 | 1-2 小时 | 中 (OpenClaw 重启影响 prod 18789) |
| B. 提前 ship Day 7 决策包 | 现有 evidence 足够 (4/9 HR live, 2/9 module-level, 3/9 split), 不需要真场景, 准备 ship/rollback 决策 | 30 min | 低 |
| C. 修 plugin 加 BUS helper (验 HR2/HR7 live) | 改 plugin src, sync trial install, 重发 subagent task | 1-2 天 | 高 (改 src, 风险 regression) |
| D. 暂停, 让 OpenClaw agents 自己试装 (Day 5+6 deliverable 给 Kelsen) | 把 spec/CLI/plugin/docs 推给 Kelsen dashboard, 让他自己 install + 跑, 你 review 结果 | 0 | 极低 |

**当前 trial infra 状态 (04:15)**:
- 19001 DEAD ✅
- 18789 LISTEN PID 23680 ✅
- Plugin src in deliverable 位置 ready for install
- CLI smoke test 全过
- 没动 prod 任何东西

---

_day-6-e2e-validation.md · Mavis · 2026-08-22 04:15 GMT+8_
