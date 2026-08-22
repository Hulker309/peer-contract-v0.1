# Common blocks & fix — peer-contract v0.1

> For new agents joining an OpenClaw instance with the peer-contract v0.1 plugin installed.
> Companion to `spec/examples/buildV01Reply.mjs` (reference helper) and `INSTALL_NOTES.md` §Day 7 (6-step onboarding).

The plugin enforces the v0.1 envelope strictly. When a new agent's helper code makes a field-shape mistake, the plugin will BLOCK the dispatch with a specific `blockReason`. This document lists the 5 most common blocks a new agent will hit, what the helper did wrong, and how to fix.

## 1. `reply_to` not at top level (Drift 2 BLOCK)

**Block reason**: `reply_to_missing_or_misplaced` (Drift 2)

❌ **Wrong**:
```javascript
const reply = {
  schema_version: "v2",
  // ...
  context_payload: {
    reply_to: incoming.source_session_key,   // ← nested in context_payload
  },
};
```

✅ **Fix**: `reply_to` must be a top-level field on the envelope (Drift 2 check), not in the message string, not in `context_payload`.

```javascript
const reply = {
  schema_version: "v2",
  // ...other top-level fields...
  reply_to: incoming.source_session_key,      // ← top level
};
```

## 2. `source` not in agent-registry whitelist (Drift 5 BLOCK)

**Block reason**: `source_not_in_agent_whitelist` (Drift 5)

❌ **Wrong**:
```javascript
source: "new-agent",    // ← string not in agent-registry whitelist
```

✅ **Fix**: `source` must be the new agent's own `agentId` AND that agentId must have been picked up by `agent-registry.js bootstrapScan`.

```javascript
source: "new-agent",    // ← same string, but only after bootstrap
```

Verify the agentId is in the whitelist:
```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' plugins inspect peer-contract-enforcer --runtime 2>&1 | Select-String -Pattern "new-agent"
# Expect: bootstrap log contains "new-agent"
```

## 3. `sender_session_key = incoming.target_session_key` (helper design bug)

**Plugin behavior**: **NOT blocked**, but envelope field semantics are wrong (Drift 1 only checks `source`, not `sender_session_key`). The reply will be misrouted or miscounted in audit logs.

❌ **Wrong** (the original trial-week helper bug):
```javascript
sender_session_key: incoming.target_session_key,   // ← assumes reply-end = incoming target
```

✅ **Fix**: `sender_session_key` must be the **replying agent's own current session key**, not the incoming target.

```javascript
sender_session_key: currentSessionKey,            // ← reply-end's own session
```

`currentSessionKey` is passed into the helper as a parameter. See `spec/examples/buildV01Reply.mjs` for the full pattern.

## 4. `correlation_id` null on a sub-task (Drift 6 BLOCK)

**Block reason**: `correlation_id_required_for_subtask` (Drift 6)

❌ **Wrong**:
```javascript
{
  dispatch_id: "d-sub-001",
  parent_dispatch_id: "d-parent-001",      // ← this is a sub-task
  correlation_id: null,                      // ← Drift 6 BLOCK
}
```

✅ **Fix**: For a sub-task (anything with a non-null `parent_dispatch_id`), `correlation_id` must be a meaningful thread id. Pass through the parent's `correlation_id`, or start a new thread id.

```javascript
{
  dispatch_id: "d-sub-001",
  parent_dispatch_id: "d-parent-001",
  correlation_id: "thread-xyz-2026",        // ← parent's correlation_id, or a new thread id
}
```

## 5. Missing v0.1 schema fields (HR6 BLOCK)

**Block reason**: `envelope_missing_required_fields` (HR6 schema validation)

❌ **Wrong** (v1.1 markdown style):
```javascript
{
  schema_version: "v2",
  context_payload: { "task_spec": "..." }
  // ← missing protocol_version / acceptance_policy / reply_to / etc.
}
```

✅ **Fix**: All 20+ required fields must be present. Reference `spec/examples/buildV01Reply.mjs` for the full template. Top-level required:

- `schema_version` / `protocol_version`
- `dispatch_id` / `parent_dispatch_id` / `original_dispatch_id`
- `retry_count` / `correlation_id` / `card_id` / `parent_card_id`
- `goal`
- `sender_role` / `sender_session_key` / `target_role` / `target_session_key`
- `reply_to` / `source` / `intent`
- `context_payload` `{ task_spec / extracted_history / acceptance_criteria }`
- `payload_completeness` / `priority` / `max_runtime_minutes` / `expected_reply_format`
- `acceptance_policy` `{ ac_owner / ac_immutable_by_worker / verifier / retry_on_fail / max_retry_count }`

## How to debug a block

When a dispatch is BLOCKED, the plugin writes an entry to:

```
C:\Users\Administrator\.openclaw\agents\<your-agent-id>\peer-contract-enforcer-audit.jsonl
```

Each entry has `blockReason` and `details` fields. The 5 block reasons above cover the most common cases. For less common cases, the full list is in `docs/architecture.md` §enforcement rules.

## See also

- `INSTALL_NOTES.md` §Day 7 — 6-step server-side onboarding for OpenClaw admin
- `spec/examples/buildV01Reply.mjs` — reference helper for new agent reply implementation
- `docs/known-limitations.md` — P0-3 migration gap (doesn't block new agents)
