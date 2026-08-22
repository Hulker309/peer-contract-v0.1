# peer-contract v0.1

> **Generic agent-to-agent communication protocol + OpenClaw plugin**
> Version: 0.1.0  |  Ship date: 2026-08-22  |  License: MIT

Universal protocol for dispatching work between agents. Five JSON Schemas define the wire format; a zero-dep Node.js CLI validates envelopes; an OpenClaw plugin enforces hard rules (HR1–HR9) at runtime.

## What problem does this solve

When agents (LLM-driven or otherwise) need to delegate work to each other, three things go wrong without a contract layer:

1. **Implicit routing** — work lands on the wrong session (often the coordinator's main session) because the dispatcher had to guess a target
2. **Context leakage** — the receiver inherits too much / too little state and either over-acts or under-acts
3. **No accountability** — there's no audit trail of who-dispatched-what-with-what-AC, so the chain of responsibility breaks down

This protocol fixes all three with:

- **Explicit `target_session_key`** on every dispatch (HR1: no-default-to-main)
- **Self-contained payloads** with explicit `context_scope` (HR4 / HR5)
- **Acceptance criteria** frozen at dispatch, immutable by the worker (HR7)
- **Audit log** per cross-session query, write-once, per-agent file (HR5)

## Status: production-ready

- 5/7 end-to-end tests PASS + 2/7 BLOCK (correct behavior per design intent — see [`docs/known-limitations.md`](docs/known-limitations.md))
- 166/166 unit tests PASS
- Plugin v0.1.0 running on OpenClaw prod 18789 (PID verified at install)
- 8 fix iterations across Day 5 (spec + CLI) and Day 6 (plugin install + Issues 1/2/3 + #8 correlation_id)

See [`docs/architecture.md`](docs/architecture.md) for design rationale and [`docs/known-limitations.md`](docs/known-limitations.md) for what was deferred.

## Quick start

```bash
# 1. Validate a dispatch envelope (no install needed)
node impl/cli/bin/peer-contract.js check my-envelope.json
# Exit 0 = OK, exit 1 = BLOCK (errors printed)

# 2. Run scenarios
node impl/cli/bin/peer-contract.js dry-run scenarios/01-basic-dispatch.yaml --reset-state

# 3. Install the OpenClaw plugin
#    See INSTALL.md for full procedure (no npm global, no PATH change, no pollution)

# 4. Run unit tests
cd impl/openclaw-plugin/peer-contract-enforcer
npm test
```

## Repository layout

```
peer-contract-v0.1/
├── README.md                        # this file
├── INSTALL.md                       # install / uninstall
├── LICENSE                          # MIT
├── package.json                     # workspace metadata
├── .gitignore
├── spec/                            # Public protocol spec (platform-agnostic)
│   ├── 00-protocol-overview.md
│   ├── 01-dispatch.schema.json      # HR1, HR2, HR3, HR6
│   ├── 02-isolation.schema.json     # HR4, HR5
│   ├── 03-multi-turn.schema.json    # HR7 (AC chain)
│   ├── 04-bus.schema.json           # bus coordination
│   └── 99-envelope.schema.json      # full envelope (wire format)
├── impl/
│   ├── cli/                         # Zero-dep Node.js CLI
│   │   ├── bin/peer-contract.js     # entry point
│   │   ├── src/
│   │   │   ├── lib/                 # schema-loader, validator, ac-tracker, reporter
│   │   │   └── commands/            # check, validate-schema, ac-chain, dry-run
│   │   └── tests/                   # CLI test fixtures
│   └── openclaw-plugin/             # OpenClaw runtime binding (the enforcement)
│       └── peer-contract-enforcer/
│           ├── openclaw.plugin.json
│           ├── package.json
│           ├── INSTALL_NOTES.md      # detailed install + 8 fix addenda
│           ├── src/                  # 12 .js files
│           └── tests/                # 10 .mjs files (166/166 PASS)
├── scenarios/                       # dry-run YAML scenarios
│   ├── 01-basic-dispatch.yaml
│   └── 02-multi-turn-ac-chain.yaml
└── docs/                            # Maintainability documentation
    ├── architecture.md              # How the plugin works, hook sequence
    ├── maintainability.md           # How to extend, debug, fix
    ├── known-limitations.md         # Future work, deferred items
    └── post-install-procedures.md   # Audit log routing, session-registry bootstrap
```

## Design principles

1. **Spec is data, not code** — 5 JSON Schemas (Draft 2020-12). Any platform can consume.
2. **Zero dependency, zero vendor lock-in** — CLI is pure Node.js, no `ajv` / `zod` / `js-yaml`. The OpenClaw plugin needs only `typebox` (which OpenClaw already ships).
3. **No pollution of other software** — no `npm install -g`, no PATH change, no system config.
4. **Public spec vs internal implementation** — `spec/` is platform-agnostic and human-readable. `impl/` is one runtime binding (OpenClaw). Other runtimes (Hermes, custom agents, CI) can implement the spec without touching the OpenClaw plugin.
5. **HR rules split runtime vs static** — 5 runtime rules (HR1/3/5/6/9) enforced by the plugin; 4 static rules (HR2/4/7/8) enforced by schema validation. Runtime catch what static misses; static keeps runtime cheap.

## What this is NOT

- **Not a transport** — it doesn't define wire protocols, queues, or RPC. It defines what the payload looks like over whatever transport you use.
- **Not a service registry** — `target_session_key` is opaque; you bring your own session directory.
- **Not a workflow engine** — AC chain tracks acceptance criteria, not DAG dependencies.
- **Not a multi-tenant platform** — there's no auth, no namespace, no quota. Add these at the transport layer.

## Versioning and stability

- v0.1.x → bug fixes, no schema changes
- v0.2.x → additive schema changes (new fields with defaults)
- v1.0 → first stable contract; breaking changes require a major version bump

Per current design (no v0.2, single-shot protocol layer), the project is in v0.1.0 maintenance mode. Future work is captured in [`docs/known-limitations.md`](docs/known-limitations.md).

## Contributing

Patches welcome. Read [`docs/maintainability.md`](docs/maintainability.md) first — it covers:
- How to add a new HR rule
- How to extend the schema
- How to debug a runtime check
- The 8-fix history (so you don't re-introduce the same bugs)

## Credits

- **Strategic intent**: Hulker309 (boss) — 2026-08-18 strategic direction, 2026-08-19 "generic protocol layer template", 2026-08-22 10:40 design intent confirmation
- **Plugin author**: Mavis (MiniMax Code peer agent) — Day 5 spec + CLI, Day 6 plugin install, 8 fix iterations
- **End-to-end validation**: Kelsen (OpenClaw main CEO) — 4 rounds of source + e2e review caught 4 dead-code / fallback / lifecycle bugs (P0-1 / P0-2 / P1 / P0-3) that Mavis would have shipped without source review
- **Trial week agents (8/19–8/22)**: Kelsen + Coder — original 5 trial rounds; their session JSONL preserved as audit trail in `~/.openclaw/agents/coder/sessions/`

## License

MIT. See [LICENSE](LICENSE).
