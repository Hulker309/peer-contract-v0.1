# Architecture

> How the peer-contract v0.1 OpenClaw plugin works, and why.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                       OpenClaw Gateway 18789                         │
│                                                                     │
│  ┌────────────┐    ┌─────────────────────────────────────┐         │
│  │ QQ bot     │    │  Agent Runtime                      │         │
│  │ channel    │    │                                     │         │
│  └────┬───────┘    │  ┌──────────┐  ┌──────────┐  ┌────┴───┐  │         │
│       │            │  │ main     │  │ bus      │  │ work   │  │         │
│       │            │  │ session  │  │ session  │  │ session│  │         │
│       ▼            │  └────┬────┘  └────┬─────┘  └────┬───┘  │         │
│  ┌────────────┐    │       │            │             │       │         │
│  │ chat msg   │────┼───────┴────────────┴─────────────┘       │         │
│  └────────────┘    │  sessions_send (HR1/HR6 enforce)            │         │
│                    └──────────────┬─────────────────────────────┘         │
│                                   │                                    │
│                    ┌──────────────▼─────────────────────────────┐    │
│                    │  peer-contract-enforcer plugin             │    │
│                    │                                             │    │
│                    │  ┌────────────────────────────────────┐   │    │
│                    │  │ before_tool_call hook               │   │    │
│                    │  │  - sessions_send → HR1-HR9 chain  │   │    │
│                    │  │  - sessions_history/memory_search   │   │    │
│                    │  │    → audit log (HR5)               │   │    │
│                    │  └────────────────────────────────────┘   │    │
│                    │                                             │    │
│                    │  ┌────────────────────────────────────┐   │    │
│                    │  │ session_start / subagent_spawned   │   │    │
│                    │  │  - role-registry population         │   │    │
│                    │  │  - session-registry tracking        │   │    │
│                    │  │  - agent-registry whitelist        │   │    │
│                    │  │  - correlation_id propagation      │   │    │
│                    │  └────────────────────────────────────┘   │    │
│                    │                                             │    │
│                    │  ┌────────────────────────────────────┐   │    │
│                    │  │ message_sending hook                │   │    │
│                    │  │  - cross_session_message audit      │   │    │
│                    │  └────────────────────────────────────┘   │    │
│                    └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────┐
                          │  Per-agent audit log   │
                          │  <home>/agents/<id>/   │
                          │  peer-contract-        │
                          │  enforcer-audit.jsonl  │
                          └────────────────────────┘
```

## The 9 Hard Rules (HR1–HR9)

The protocol defines 9 "hard rules" — invariants that every dispatch must satisfy. They're split into **runtime** (enforced by the plugin in `before_tool_call`) and **static** (enforced by schema validation only, at the edge).

| Rule | Where | What |
|---|---|---|
| **HR1** no-default-to-main | runtime (intent-aware + cross-agent-to-work) | `target_session_key` cannot be a main session unless intent is in `mainIntentsAllowlist` (default: `inform`, `query`, `sub-task`, `response`, `ack`, `ping`). Also: cross-agent dispatch to work is blocked. |
| **HR2** no-cross-work-direct | runtime | A work session can only `sessions_send` to its own parent bus (not other agents' buses, not other work sessions). |
| **HR3** no-user-to-work | runtime | Channel-originated sessions (e.g. QQ messages) cannot dispatch directly to a work session. |
| **HR4** payload-self-contained | static (schema) | `context_payload` must include all required fields; no "look this up" implicit references. |
| **HR5** audit-cross-session-query | runtime (audit only) | Every `sessions_history` / `memory_search` / `message_sending` is appended to the audit log. Non-blocking. |
| **HR6** reject-missing-routing | runtime | `target_session_key` must resolve via `sessionRegistry.validateSessionKey`; sender must match `ctx.sessionKey` if both are present. |
| **HR7** immutable-AC-by-worker | runtime | AC cached at dispatch. Worker dispatching with a different `acceptance_criteria` for the same `card_id` is blocked. |
| **HR8** payload-size-cap | static + runtime (HR8) | `JSON.stringify(params).length` must be ≤ `payloadSizeCapBytes` (default 64KB). |
| **HR9** work-toolset-restricted | runtime | Work sessions can't use `message`, `music_generate`, `image_generate`, `video_generate`, `skill_workshop`. (Day 6a+: `sessions_spawn` removed — work can spawn sub-work for bus/work separation, with cross-agent abuse caught by HR1.) |

The split is intentional: static rules are cheap to validate at the schema layer; runtime rules need session context. Putting everything in the schema would require runtime session lookup during JSON Schema validation, which doesn't fit OpenClaw's hook model.

## The dispatch pipeline

When an agent calls `sessions_send`, the flow is:

```
caller (bus/work/main)
    │
    ▼
OpenClaw before_tool_call hook
    │
    ▼
peer-contract-enforcer
    │
    ├─ 1. extractDispatchPayload(params)
    │     Extract v2 envelope from 4 possible shapes:
    │     - v2_top_level: payload at top of params
    │     - v2_message_object: payload at params.message (object)
    │     - v2_message_string: payload at params.message (JSON string)
    │     - legacy v1.1: extract from message string ("[peer-contract v1.1] ...")
    │
    ├─ 2.5. auto-fill correlation_id (Day 6a+)
    │     - new task root (parent_dispatch_id=null): correlation_id = dispatch_id
    │     - sub-task (parent set, original null): original_dispatch_id = parent_dispatch_id
    │     - explicit values not overridden
    │
    ├─ 3-4. Resolve sender / target session keys
    │     sender = payload.sender_session_key ?? ctx.sessionKey
    │     target = extracted.targetSessionKey ?? payload.target_session_key
    │
    ├─ 5. HR1: validateNoDefaultToMain(target, sender, {intent, ...})
    │     - intent-aware: target=main allowed if intent in mainIntentsAllowlist
    │     - cross-agent-to-work blocked: sender agentId ≠ target agentId AND target matches work pattern
    │
    ├─ 6. HR6 schema: validateV2Schema(payload)
    │     - all V2_REQUIRED_TOP_FIELDS present
    │     - sender_role / target_role in ["main","bus","work"] (Day 6a+: includes "main")
    │
    ├─ 6.5. CONTRACT: validateContractCompliance(params, ctx, {agentRegistry, validAgentIds})
    │     - Drift 1: source field must equal sender agentId
    │     - Drift 2: reply_to required (v1.1 contract metadata)
    │     - Drift 4: reply_to=main requires authorized_by signal
    │     - Drift 5: source must be a registered agentId (no phantom agents)
    │     - Drift 6: sub-task must carry correlation_id (chain integrity)
    │
    ├─ 7. HR6 session-existence: validateSessionExistence(target, sessionRegistry)
    │     - target_session_key must be in sessionRegistry
    │
    ├─ 8. tool-guard beforeToolCall: HR2/HR3/HR4/HR7/HR9 logic
    │     - callerRole inferred from ctx.sessionKey + policy patterns
    │     - HR2: work→bus only if target = work's parent (parentSessionKey from role-registry)
    │     - HR3: ctx.messageProvider + target=work → block
    │     - HR7: AC cache check (callerRole=work, cachedAc exists, ac differs → block)
    │     - HR9: work session toolset denied list
    │
    └─ 9. Day 6a+ P0-1/P0-2: write-back + pre-fill
          - v2_message_string shape: write back auto-filled payload to event.params.message
          - target session: pre-fill sessionRegistry with correlationId (for downstream hooks to read)
```

## State stores

Three in-memory stores, all backed by the plugin instance (lost on restart, except `sessionRegistry` which has a filesystem bootstrap):

| Store | Key | Value | Purpose |
|---|---|---|---|
| `roleRegistry` | sessionKey | `{role, parentSessionKey, agentId, cardId, subTaskId}` | HR2 parent check (callerInfo?.parentSessionKey) |
| `sessionRegistry` | sessionKey | `{agentId, correlationId, source, registeredAt}` | HR6 session existence + correlation_id propagation |
| `acCache` | cardId | `{ac, createdAt, expiresAt, setBy, agentId}` | HR7 AC immutability |
| `agentRegistry` | agentId | `{source, registeredAt}` | Drift 5 phantom-agent whitelist |
| `auditLogger` | (ring buffer + JSONL file) | event entries | HR5 audit log |

`sessionRegistry` is bootstrapped from `~/.openclaw/agents/<id>/sessions/*.jsonl` at plugin startup, so work sessions are pre-registered. Bus and main sessions are registered at runtime via `session_start` / `subagent_spawned` hooks.

## Why these design choices

**Why intent-aware HR1 instead of strict block?**
Without intent awareness, `Kelsen.bus → coder.bus` cross-agent dispatch is blocked because `coder.bus` is technically a "main" session key (literal `agent:coder:main`). The intent allowlist lets `inform` / `query` / `sub-task` / `response` / `ack` / `ping` reach a main session, while keeping `task_assignment` (the dangerous default-routing intent) blocked.

**Why cross-agent-to-work block?**
A work session is the "hands" of an agent, not its public API. Dispatching from `Kelsen.bus` directly to `coder.work` skips `coder.bus` (coder's "brain") and forces coder's hand. That violates the distributed-coordination mental model. Cross-agent dispatch must go through the target agent's public layer (main or bus).

**Why session_start inherits from existing entry?**
OpenClaw fires `subagent_spawned` BEFORE `session_start`. The original code had `session_start` overwrite `parentSessionKey` with `undefined`, breaking the HR2 parent check. Fix: read existing entry, inherit `parentSessionKey` / `subTaskId` / `cardId`. Without this, HR2 is dead code.

**Why CLI is zero-dep?**
A protocol layer should be implementable anywhere. `ajv` is great but tying the CLI to it means anyone who wants to validate an envelope needs npm. Pure Node.js validation (a few hundred lines) is enough for v0.1 and runs anywhere Node runs.

## Hook ordering and "defense in depth"

When multiple rules could block the same call, the order is:

```
HR6 (session-existence)        — fastest, blocks the most irrelevant calls first
  → HR1 (no-default-to-main)   — semantically cheapest semantic check
    → HR6 schema (V2 required fields)
      → CONTRACT (Drift 1-6)    — chain integrity, source impersonation, etc.
        → HR2 (work→bus)        — needs role-registry + callerInfo
          → HR7 (AC immutability) — needs acCache
            → HR9 (work toolset) — needs callerRole
```

Each layer is independent — if you disable one (e.g. `dryRun: true` or a config flag), the others still run. This is intentional: defense in depth. See `docs/maintainability.md` for how to disable individual rules during testing.

## Why no `package.json` workspaces / no monorepo tooling

The repo has three sub-projects (`spec/`, `impl/cli/`, `impl/openclaw-plugin/peer-contract-enforcer/`) with different dependencies and different runtime environments:

- `spec/`: pure data, no deps
- `impl/cli/`: zero deps, runs on raw Node.js
- `impl/openclaw-plugin/peer-contract-enforcer/`: needs `typebox` (already in OpenClaw), runs inside OpenClaw plugin loader

A monorepo tool (pnpm workspaces, lerna) would add install complexity for no benefit — each sub-project is independently installable. The plugin's `package.json` is a standalone OpenClaw plugin manifest, not a workspace member.
