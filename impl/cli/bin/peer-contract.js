#!/usr/bin/env node
// peer-contract v0.1 CLI - entry point
// Zero deps, runs on Node 18+. No install needed.
// Usage: node bin/peer-contract.js <command> [args]
//        Or: ./bin/peer-contract.js <command> [args]  (if executable)

const path = require('path');

const COMMANDS = {
  'check':           { file: 'commands/check.js',           desc: 'Pre-dispatch envelope validation (no side effects)' },
  'validate-schema': { file: 'commands/validate-schema.js', desc: 'Validate any JSON file against a schema' },
  'ac-chain':        { file: 'commands/ac-chain.js',        desc: 'Inspect / append to AC chain state' },
  'dry-run':         { file: 'commands/dry-run.js',         desc: 'End-to-end scenario simulation' },
  '--version':       { handler: () => { console.log('peer-contract 0.1.0'); process.exit(0); } },
  '-v':              { handler: () => { console.log('peer-contract 0.1.0'); process.exit(0); } },
  '--help':          { handler: printHelp },
  '-h':              { handler: printHelp },
};

function printHelp() {
  console.log(`peer-contract v0.1.0 - Agent-to-agent protocol CLI

Usage: peer-contract <command> [args]

Commands:
  check <envelope.json>            Validate envelope (routing + isolation + size cap). Exit 0 = OK, 1 = BLOCK.
  validate-schema <file> <schema>  Validate any JSON against a schema file.
  ac-chain <subcommand>           AC chain tracker. subcommand: list | append | get <card_id>
  dry-run <scenario.yaml>          Simulate multi-agent dispatch scenario. Returns each step OK/BLOCK.

Options:
  --version, -v                    Show version
  --help, -h                       Show this help

Examples:
  peer-contract check envelope.json
  peer-contract validate-schema my-message.json ../spec/01-dispatch.schema.json
  peer-contract ac-chain append --card task-1.ac1 --status accepted --by agent:kelsen:main
  peer-contract dry-run ../../scenarios/02-multi-turn-ac-chain.yaml

Zero dependencies, zero global state. Drop into any Node 18+ project.
`);
  process.exit(0);
}

const [, , cmd, ...args] = process.argv;

if (!cmd) {
  printHelp();
}

const entry = COMMANDS[cmd];
if (!entry) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Run 'peer-contract --help' for usage.`);
  process.exit(2);
}

if (entry.handler) {
  entry.handler();
}

// Resolve and run command file
const cmdPath = path.join(__dirname, '..', 'src', entry.file);
try {
  const mod = require(cmdPath);
  if (typeof mod.run !== 'function') {
    console.error(`Command ${cmd} does not export run().`);
    process.exit(2);
  }
  mod.run(args).then(
    (exitCode) => { if (typeof exitCode === 'number') process.exit(exitCode); },
    (err) => {
      console.error(`Command ${cmd} failed:`, err && err.message ? err.message : err);
      if (err && err.stack && process.env.PEER_CONTRACT_DEBUG) console.error(err.stack);
      process.exit(1);
    }
  );
} catch (e) {
  if (e.code === 'MODULE_NOT_FOUND') {
    console.error(`Cannot load command: ${cmdPath}`);
    console.error(`This usually means the CLI is incomplete. Run from impl/cli/ directory.`);
  }
  throw e;
}
