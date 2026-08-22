# Bus Coordination

> **Complements**: `spec/04-bus.schema.json`
> **Author**: Mavis
> **Date**: 2026-08-22 04:05 GMT+8

This doc explains **bus** as a coordination mechanism, not a message queue. Bus is where multi-agent workflows are orchestrated.

## What bus is and isn't

**Bus IS**:
- A coordination layer that owns task assignment, progress sync, AC chain tracking
- The only path between work sessions (HR2 enforces this)
- The audit/dashboard layer (bus sessions see all coordination events)
- Owned by 1+ dedicated `bus` role sessions per agent

**Bus is NOT**:
- A simple message queue (no FIFO semantics, no broker/consumer model)
- A real-time pub/sub (dispatches are explicit, not pushed)
- A workflow engine (bus tracks state, but doesn't execute; work sessions do)
- A single point of failure (each agent can have its own bus session)

## Why bus exists

The 8/18 老板 4 核心问题里:

> bus 里面 agent 有没有消息理解的能力？因为你会发现总线实际上不是完全总线，而是任务分配机制，并且对于任务的引导或者协作这件事本身是有意义的。

**The bus is a coordination mechanism** — it tracks what's been assigned, what's in progress, what's overdue, and routes yields. Work sessions don't need to "understand" all messages; they just yield to bus and let bus decide.

## Bus session types

A bus session is identified by session key:
```
agent:<agent-id>:bus:<context-id>
```

Examples:
- `agent:peer-trial:bus:dashboard` — main coordination bus for peer-trial agent
- `agent:peer-trial:bus:webchat:user-123` — per-user-channel bus for webchat user 123
- `agent:kelsen:bus:dispatch` — Kelsen's dispatch bus

A bus session is "owned" by the agent's main session (created at agent startup), and persists across dispatches.

## Coordination flows

### Flow 1: task_assignment

Main → bus → work

```json
// Main → bus (assignment)
{
  "routing": { "source": "agent:peer-trial:main", "target": "agent:peer-trial:bus:dashboard" },
  "bus": {
    "coordination_kind": "task_assignment",
    "task_assignment": {
      "task_id": "task-42",
      "assign_to": "agent:peer-trial:work:task-42:primary",
      "expected_completion": "2026-08-22T08:00:00Z",
      "priority": "high",
      "block_until_complete": false
    },
    "bus_session_required": true
  }
}

// Bus → work (real dispatch)
{
  "routing": { "source": "agent:peer-trial:bus:dashboard", "target": "agent:peer-trial:work:task-42:primary" },
  "multi_turn": { "lifecycle": "spawn_request", "sub_session_request": { "task_id": "task-42", "parent_session_key": "agent:peer-trial:bus:dashboard" } },
  "bus": { "coordination_kind": "task_assignment", "task_assignment": { "task_id": "task-42", "assign_to": "..." } }
}
```

Note: The bus is a **pass-through** here, but it has the option to:
- Split the task into sub-tasks
- Reject and re-route
- Delay dispatch (priority queue)
- Log the assignment for audit

### Flow 2: progress_sync

Work → bus (status report)

```json
{
  "routing": { "source": "agent:peer-trial:work:task-42:primary", "target": "agent:peer-trial:bus:dashboard" },
  "bus": {
    "coordination_kind": "progress_sync",
    "progress_sync": {
      "agent_id": "peer-trial",
      "current_state": "running",
      "active_task_ids": ["task-42"],
      "yielded_dispatch_ids": ["<uuid-y1>"],
      "last_heartbeat": "2026-08-22T05:30:00Z"
    }
  }
}
```

Bus uses this to:
- Update dashboard
- Detect stale/overdue tasks
- Trigger escalation if no heartbeat in N minutes
- Update audit trail

### Flow 3: yield_report

Work → bus → main (interim or final yield)

```json
// Work → bus
{
  "routing": { "source": "agent:peer-trial:work:task-42:primary", "target": "agent:peer-trial:bus:dashboard" },
  "bus": {
    "coordination_kind": "yield_report",
    "yield_report": {
      "task_id": "task-42",
      "yielded_by": "agent:peer-trial:work:task-42:primary",
      "yield_status": "interim",
      "yield_content_ref": "<uuid-yield-body>",
      "next_action_requested": "continue"
    }
  }
}

// Bus → main (forwarded)
{
  "routing": { "source": "agent:peer-trial:bus:dashboard", "target": "agent:peer-trial:main" },
  "in_reply_to": "<uuid-yield-body>"
}
```

Note: bus may **transform** the yield (e.g. summarize, attach context) before forwarding. Or it may **block** the yield (e.g. if main is currently in a "do not disturb" state).

### Flow 4: ack / nack

Bus → work (response to a yield or task)

```json
{
  "routing": { "source": "agent:peer-trial:bus:dashboard", "target": "agent:peer-trial:work:task-42:primary" },
  "bus": {
    "coordination_kind": "ack",
    "yield_report": { "task_id": "task-42", "yielded_by": "agent:peer-trial:bus:dashboard", "next_action_requested": "continue" }
  }
}
```

`nack` is "I received but I'm not satisfied" — typically followed by a `revise` action.

### Flow 5: broadcast

Bus → multiple recipients

```json
{
  "routing": { "source": "agent:peer-trial:bus:dashboard", "target": "agent:peer-trial:work:*" },
  "bus": {
    "coordination_kind": "broadcast",
    "broadcast": { "scope": "role_filter", "role_filter": ["work"] }
  }
}
```

Use cases:
- "All work sessions: pause for 5 minutes, system maintenance"
- "All agents in dialog X: please report status"

## Bus state model

Bus session maintains this state (in-memory + JSONL snapshot):

```js
{
  tasks: {
    "task-42": {
      task_id: "task-42",
      status: "running",  // pending | running | completed | failed
      assign_to: "agent:peer-trial:work:task-42:primary",
      expected_completion: "2026-08-22T08:00:00Z",
      priority: "high",
      history: [
        { ts: "...", event: "assigned", from: "main" },
        { ts: "...", event: "accepted", from: "work" },
        { ts: "...", event: "yielded_interim", from: "work", yield_ref: "..." }
      ]
    }
  },
  agents: {
    "agent:peer-trial:work:task-42:primary": {
      session_key: "...",
      current_state: "running",
      last_heartbeat: "2026-08-22T05:30:00Z"
    }
  }
}
```

This is bus-local state, not part of the spec. Different bus implementations may store it differently.

## Bus as policy enforcement point

Bus sessions are the **only** sessions that can:
- Reassign tasks (move from one work session to another)
- Cancel a task (transition to `cancelled`)
- Trigger escalation
- Broadcast coordination messages

This gives bus sessions a privileged role. In a multi-agent system, the bus is effectively the **orchestrator**. Work sessions are **workers**. Main sessions are **clients**.

```
┌─────────┐     ┌──────┐     ┌────────┐
│  Main   │────▶│ Bus  │────▶│  Work  │
│ (client)│     │(orch)│     │(worker)│
└─────────┘     └──────┘     └────────┘
     │              │              │
     │              │              │
     ▼              ▼              ▼
  (task desc)  (state track)   (exec task)
  (AC accept)  (audit log)     (yield to bus)
                (priority)      (no client)
```

## Bus ↔ Plugin relationship

The `peer-contract-enforcer` plugin enforces some of this at the tool-call level:
- HR1, HR3, HR6, HR9 are plugin-level
- HR2 is plugin-level (work→work direct blocked)
- HR5 is plugin-level (audit log)

But the **policy** decisions (reassign, cancel, escalate) are bus-session level. Plugin doesn't decide; plugin just **routes** according to dispatch intent.

A future "bus-policy" plugin could enforce bus-side rules (e.g. "work session cannot broadcast"). For v0.1, bus policy is left to the bus session's own logic.

## Anti-patterns

❌ **Work session as bus**: Work session should not assign tasks to other work sessions. Use bus.
❌ **Direct main↔work without bus**: Bypasses bus, breaks coordination, makes audit harder.
❌ **Bus session that "knows" task content**: Bus should track state, not interpret. Keep bus as routing layer, not semantic layer.
❌ **Long-lived yields without progress_sync**: Bus may think task is stuck. Always heartbeat at least every 5 min for long tasks.
❌ **Re-assigning mid-task without yield**: If you reassign a work session's task, the new worker has no context. The original worker should yield first, then bus can reassign.

---

_See also: `spec/04-bus.schema.json`, `scenarios/01-basic-dispatch.yaml`._
