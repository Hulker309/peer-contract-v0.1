// src/commands/ac-chain.js
// AC chain tracker subcommands: list | append | get | verify

const ac = require('../lib/ac-tracker');
const { colorize } = require('../lib/reporter');

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      flags[key] = val;
      i++;
    }
  }
  return flags;
}

async function run(args) {
  if (args.length < 1) {
    console.error('Usage: peer-contract ac-chain <list|append|get|verify> [--flags]');
    console.error('  list                                  List all ACs');
    console.error('  get <card_id>                         Get one AC');
    console.error('  append --card <card_id> --by <owner_session_key> --status <status>');
    console.error('  verify <card_id>                      Verify AC chain integrity (HR7 checks)');
    return 2;
  }
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'list') {
    const all = ac.list();
    if (all.length === 0) {
      console.log('(no ACs tracked)');
      return 0;
    }
    for (const c of all) {
      console.log(`${c.card_id}  status=${c.status}  owner=${c.owner_session_key}  history=${c.history.length} step(s)`);
    }
    return 0;
  }

  if (sub === 'get') {
    if (rest.length < 1) {
      console.error('Usage: peer-contract ac-chain get <card_id>');
      return 2;
    }
    const card = ac.get(rest[0]);
    if (!card) {
      console.log(colorize('NOT FOUND', 'yellow') + ` ${rest[0]}`);
      return 1;
    }
    console.log(JSON.stringify(card, null, 2));
    return 0;
  }

  if (sub === 'append') {
    const flags = parseFlags(rest);
    if (!flags.card || !flags.by || !flags.status) {
      console.error('Usage: peer-contract ac-chain append --card <card_id> --by <owner_session_key> --status <status>');
      return 2;
    }
    const result = ac.append(flags.card, flags.by, flags.status);
    if (!result.ok) {
      console.log(colorize('BLOCK', 'red') + ` ${result.error}`);
      return 1;
    }
    if (result.no_change) {
      console.log(colorize('OK', 'green') + ` ${flags.card} already at status=${result.status} (no change)`);
    } else {
      console.log(colorize('OK', 'green') + ` ${flags.card}: ${result.prev_status} → ${result.status} (owner: ${flags.by})`);
    }
    return 0;
  }

  if (sub === 'verify') {
    if (rest.length < 1) {
      console.error('Usage: peer-contract ac-chain verify <card_id>');
      return 2;
    }
    const card = ac.get(rest[0]);
    if (!card) {
      console.log(colorize('NOT FOUND', 'yellow') + ` ${rest[0]}`);
      return 1;
    }
    // HR7: if status=accepted, owner_session_key must be set
    if (card.status === 'accepted' && !card.owner_session_key) {
      console.log(colorize('BLOCK', 'red') + ' HR7: accepted AC has no owner_session_key');
      return 1;
    }
    // History must be monotonically advancing
    const validSeq = ['pending', 'accepted', 'in_progress', 'completed'];
    const lastStatusIdx = validSeq.indexOf(card.status);
    for (const h of card.history) {
      const idx = validSeq.indexOf(h.status);
      if (idx >= lastStatusIdx) {
        console.log(colorize('WARN', 'yellow') + ` history step ${h.status} not before current ${card.status}`);
      }
    }
    console.log(colorize('OK', 'green') + ` ${rest[0]} verified: status=${card.status} owner=${card.owner_session_key} history=${card.history.length}`);
    return 0;
  }

  console.error(`Unknown ac-chain subcommand: ${sub}`);
  return 2;
}

module.exports = { run };
