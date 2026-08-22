# Multi-turn Sub-session Patterns

> **Complements**: `spec/03-multi-turn.schema.json`
> **Author**: Mavis
> **Date**: 2026-08-22 04:00 GMT+8

This doc explains **how** to use the multi-turn schema in practice. The schema defines fields; this doc shows the patterns.

## Why multi-turn is needed

OpenClaw `sessions_spawn` creates a **single-shot** subagent — runs once, returns, gone. But complex tasks (e.g. refactoring across 5 files, then validating, then writing tests) need **multi-round** interaction:

- Round 1: parse 5 files
- Round 2: write refactored code
- Round 3: run tests, fix failures
- Round 4: report back

A single `sessions_spawn` can't do this. The sub-session must be **persistent** and able to **yield** mid-task and resume.

The multi-turn schema describes how to drive this from a parent (main or bus) session.

## Pattern 1: Main → Work spawn + AC

Use case: Main session wants to delegate a complex task to a work session.

**Step 1**: Main sends `sub_session_request` envelope:

```json
{
  "version": "0.1.0",
  "envelope_id": "<uuid>",
  "routing": {
    "dispatch_id": "<same uuid>",
    "dialog_key": "task.42.refactor",
    "source_session_key": "agent:peer-trial:main",
    "target_session_key": "agent:peer-trial:work:task-42:primary",
    "source_role": "main",
    "target_role": "work",
    "timestamp": "2026-08-22T04:00:00Z",
    "intent": "task_assignment"
  },
  "isolation": {
    "context_scope": "self",
    "payload_self_contained": true,
    "cross_session_query_ack": false,
    "context_leak_protection": "strict"
  },
  "multi_turn": {
    "lifecycle": "spawn_request",
    "yield_pattern": ["pending", "accepted", "in_progress", "yielded", "completed"],
    "sub_session_request": {
      "task_id": "task-42",
      "parent_session_key": "agent:peer-trial:main",
      "expected_yield": "multi_yield"
    },
    "acceptance_criteria": {
      "card_id": "task-42.ac1",
      "criteria_text": "Refactor 5 files + tests pass",
      "status": "pending"
    }
  },
  "bus": {
    "coordination_kind": "task_assignment",
    "task_assignment": {
      "task_id": "task-42",
      "assign_to": "agent:peer-trial:work:task-42:primary",
      "expected_completion": "2026-08-22T08:00:00Z",
      "priority": "high"
    },
    "bus_session_required": true
  },
  "body": {
    "task": "Refactor 5 files: ...",
    "constraints": ["tests must pass", "no breaking changes"]
  },
  "size_cap": { "max_bytes": 65536, "current_bytes": 1450 }
}
```

**Step 2**: Work session accepts AC (status: pending → accepted):

```json
{
  "version": "0.1.0",
  "envelope_id": "<uuid-2>",
  "routing": { "source": "agent:peer-trial:work:task-42:primary", "target": "agent:peer-trial:main", "intent": "ac_acceptance" },
  "multi_turn": { "lifecycle": "active", "acceptance_criteria": { "card_id": "task-42.ac1", "status": "accepted", "accepted_by": "agent:peer-trial:work:task-42:primary" } }
}
```

After this, `accepted_by` is **immutable** (HR7).

**Step 3**: Work session yields periodically back to main:

```json
{
  "routing": { "source": "agent:peer-trial:work:task-42:primary", "target": "agent:peer-trial:bus:dashboard", "intent": "yield_report" },
  "multi_turn": { "lifecycle": "yielded" },
  "bus": { "coordination_kind": "yield_report", "yield_report": { "task_id": "task-42", "yielded_by": "agent:peer-trial:work:task-42:primary", "yield_status": "interim", "next_action_requested": "continue" } }
}
```

Note: Work session **must** yield to a **bus** session, not main. Direct work→main is blocked by HR1 (universal main-forbidden).

**Step 4**: Bus forwards to main with AC evidence.

**Step 5**: Work advances AC and finalizes:

```json
{ "multi_turn": { "lifecycle": "completed", "acceptance_criteria": { "card_id": "task-42.ac1", "status": "completed", "evidence_dispatch_ids": ["<uuid-y1>", "<uuid-y2>"] } } }
```

## Pattern 2: Work → Work through bus relay

Use case: Two work sessions need to coordinate.

```
Work A → (HR2 blocks direct) → Work B
Work A → (via bus) → Work B
```

Work A cannot dispatch to Work B directly (HR2). The path is:

1. Work A yields to bus
2. Bus re-dispatches to Work B
3. Work B processes, yields back to bus
4. Bus re-dispatches to Work A

**Work A's yield-to-bus**:
```json
{
  "routing": { "source": "agent:A:work:task-X:primary", "target": "agent:A:bus:dashboard" },
  "bus": { "coordination_kind": "yield_report", "yield_report": { "task_id": "task-X", "yielded_by": "agent:A:work:task-X:primary", "next_action_requested": "continue" } },
  "body": { "delegate_to": "agent:B:work:task-Y:primary", "reason": "need B's data" }
}
```

**Bus's re-dispatch to Work B**:
```json
{
  "routing": { "source": "agent:A:bus:dashboard", "target": "agent:B:work:task-Y:primary" },
  "bus": { "coordination_kind": "task_assignment", "task_assignment": { "task_id": "task-Y", "assign_to": "agent:B:work:task-Y:primary" } }
}
```

This is how HR2 is enforced in practice: the **bus** is the only path between work sessions.

## Pattern 3: AC chain across multiple work sessions

Use case: Task has 3 sub-tasks, each handled by a different work session.

```json
{
  "multi_turn": {
    "lifecycle": "active",
    "ac_chain": [
      { "card_id": "task-42.ac1", "owner_session_key": "agent:work:task-42:sub-1:primary", "status": "completed" },
      { "card_id": "task-42.ac2", "owner_session_key": "agent:work:task-42:sub-2:primary", "status": "in_progress" },
      { "card_id": "task-42.ac3", "owner_session_key": "agent:work:task-42:sub-3:primary", "status": "pending" }
    ]
  }
}
```

Each AC node is owned by one work session. Only the owner can update its status (HR7). Other sessions have read-only view.

If a session tries to modify another session's AC, HR7 blocks:
```
"BLOCK: HR7: cannot change owner after accept (current owner: agent:work:task-42:sub-1:primary)"
```

## Pattern 4: Failed AC (rollback)

If a task fails, work session can transition AC to `rejected`:

```json
{ "multi_turn": { "lifecycle": "cancelled", "acceptance_criteria": { "status": "rejected" } } }
```

The bus sees this and can decide:
- Reassign to a different work session
- Mark whole task as failed
- Rollback upstream state

## Anti-patterns (what NOT to do)

❌ **Work → Main direct dispatch**: HR1 blocks. Use work → bus → main.
❌ **Work → Work direct dispatch**: HR2 blocks. Use bus relay.
❌ **Modifying another session's AC**: HR7 blocks. Each session owns its own AC nodes.
❌ **Channel-originated → Work direct**: HR3 blocks. Webchat/Telegram/Discord user must go through bus.
❌ **Implicit context sharing across sessions**: Violates isolation. Use `context_scope: "explicit_query"` + `cross_session_query_ack: true` and `cross_session_query` audit log entry.
❌ **Same AC owned by two sessions**: AC is single-owner. If you need shared AC, use `ac_chain` with multiple nodes.

## Yield patterns in detail

| Pattern | When to use | Behavior |
|---|---|---|
| `single_yield` | "Do this and tell me when done" | Work session runs to completion, single final report, then dies |
| `multi_yield` | "Do this, give me progress every 5 min" | Work session yields interim reports, then final report, then dies |
| `incremental` | "Do this, each step is its own yield" | Work session yields after each meaningful step, parent can interrupt |
| `final_only` | "Do this, no reports until done" | Work session is silent until final report, then dies |

Most production use cases want `multi_yield` (interim visibility) or `final_only` (quiet execution).

## Toolset restriction recap (HR9)

Work session has access only to:
- `read`, `write`, `exec`, `sessions_history` (read own history), `memory_search` (read own memory)
- Application-specific tools the workbench policy allows

Work session is **denied**:
- `message` (channel messages)
- `sessions_spawn` (can't spawn sub-sub-sessions)
- `music_generate`, `image_generate`, `video_generate` (content gen)
- `skill_workshop` (skill creation)

This is enforced in plugin `workbench-policy.js:13-20` (DEFAULT_WORK_DENIED_TOOLS set).

---

_See also: `spec/03-multi-turn.schema.json` for the formal contract, `scenarios/02-multi-turn-ac-chain.yaml` for a runnable example._
