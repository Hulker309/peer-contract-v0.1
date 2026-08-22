// src/commands/dry-run.js
// End-to-end scenario simulation. Reads a YAML scenario file, simulates each step,
// reports OK/BLOCK for each. NO real dispatch is sent.

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml-mini.js'); // we ship a tiny YAML reader to avoid deps
const { loadByNameWithPath } = require('../lib/schema-loader');
const { validate } = require('../lib/validator');
const ac = require('../lib/ac-tracker');
const { colorize, formatDryRunStep, formatDryRunSummary } = require('../lib/reporter');

async function runStep(step, idx, total, context) {
  const result = { ok: false, reason: '', detail: '' };

  switch (step.action) {
    case 'envelope_check': {
      // Validate the envelope (passed via context or inline in step)
      const envelope = step.envelope;
      if (!envelope) { result.reason = 'no envelope'; return result; }
      const loaded = loadByNameWithPath('99-envelope');
      const errors = validate(envelope, loaded.schema, loaded.absPath);
      if (errors.length > 0) {
        result.reason = 'schema_invalid';
        result.detail = errors.map(e => `${e.path}: ${e.message}`).join('; ');
        return result;
      }
      // Size cap
      const sizeBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf-8');
      if (sizeBytes > 65536) {
        result.reason = 'HR8_size_cap';
        result.detail = `${sizeBytes} > 65536`;
        return result;
      }
      result.ok = true;
      result.detail = `envelope_id=${envelope.envelope_id} size=${sizeBytes}B`;
      context.lastEnvelope = envelope;
      return result;
    }

    case 'hr1_check': {
      // Check HR1: target_session_key must not be a main session (when sender is also a session that shouldn't default-to-main)
      const env = step.envelope || context.lastEnvelope;
      if (!env) { result.reason = 'no envelope'; return result; }
      const target = env.routing.target_session_key;
      if (target && /^agent:[^:]+:main(:.*)?$/.test(target)) {
        // Only allowed if explicit intent
        if (env.routing.intent !== 'inform' && env.routing.intent !== 'query') {
          result.reason = 'HR1_no_default_to_main';
          result.detail = `target=${target}`;
          return result;
        }
      }
      result.ok = true;
      result.detail = `target not main (or main with explicit intent)`;
      return result;
    }

    case 'hr2_check': {
      const env = step.envelope || context.lastEnvelope;
      if (!env) { result.reason = 'no envelope'; return result; }
      if (env.routing.source_role === 'work' && env.routing.target_role === 'work') {
        result.reason = 'HR2_no_cross_work_direct';
        result.detail = `source=${env.routing.source_role} target=${env.routing.target_role}`;
        return result;
      }
      result.ok = true;
      result.detail = 'work→not work';
      return result;
    }

    case 'hr9_check': {
      // Check tool allowlist for work session
      if (!step.work_session_tools) { result.reason = 'no work_session_tools specified'; return result; }
      const denyList = ['message', 'sessions_spawn', 'music_generate', 'image_generate', 'video_generate', 'skill_workshop'];
      const violations = step.work_session_tools.filter(t => denyList.includes(t));
      if (violations.length > 0) {
        result.reason = 'HR9_work_toolset_denied';
        result.detail = `denied tools: ${violations.join(', ')}`;
        return result;
      }
      result.ok = true;
      result.detail = `tools ok (${step.work_session_tools.length} allowed)`;
      return result;
    }

    case 'isolation_check': {
      const env = step.envelope || context.lastEnvelope;
      if (!env || !env.isolation) { result.reason = 'no isolation'; return result; }
      if (env.isolation.context_scope === 'explicit_query' && !env.isolation.cross_session_query_ack) {
        result.reason = 'isolation_query_without_ack';
        result.detail = 'explicit_query requires cross_session_query_ack=true';
        return result;
      }
      result.ok = true;
      result.detail = `context_scope=${env.isolation.context_scope}`;
      return result;
    }

    case 'ac_accept': {
      const result2 = ac.append(step.card_id, step.owner_session_key, 'accepted');
      if (!result2.ok) {
        result.reason = result2.error;
        return result;
      }
      result.ok = true;
      result.detail = `accepted by ${step.owner_session_key}`;
      return result;
    }

    case 'ac_advance': {
      const result2 = ac.append(step.card_id, step.owner_session_key, step.to_status);
      if (!result2.ok) {
        result.reason = result2.error;
        return result;
      }
      result.ok = true;
      result.detail = `${step.card_id} → ${step.to_status}`;
      return result;
    }

    case 'ac_chain_attempt_modify': {
      // HR7: try to change owner of an accepted AC
      const card = ac.get(step.card_id);
      if (!card) { result.reason = 'card not found'; return result; }
      if (card.status === 'accepted' || card.status === 'in_progress' || card.status === 'completed') {
        if (card.owner_session_key !== step.new_owner) {
          result.reason = 'HR7_immutable_after_accept';
          result.detail = `current owner=${card.owner_session_key}, attempted new=${step.new_owner}`;
          return result;
        }
      }
      result.ok = true;
      result.detail = 'no modification needed';
      return result;
    }

    case 'multi_turn_yield': {
      // Simulate work session yielding back
      const env = step.envelope || context.lastEnvelope;
      if (!env) { result.reason = 'no envelope'; return result; }
      if (env.routing.source_role === 'work' && env.routing.target_role === 'bus') {
        result.ok = true;
        result.detail = `work→bus yield accepted`;
        return result;
      }
      if (env.routing.source_role === 'work' && env.routing.target_role === 'main') {
        // HR1 blocks this; would be BLOCK
        result.reason = 'HR1_work_to_main_blocked';
        result.detail = 'work sessions must yield to bus, not main directly';
        return result;
      }
      result.ok = true;
      result.detail = 'yield path acceptable';
      return result;
    }

    case 'bus_task_assignment': {
      const env = step.envelope || context.lastEnvelope;
      if (!env || !env.bus || env.bus.coordination_kind !== 'task_assignment') {
        result.reason = 'not a bus task_assignment';
        return result;
      }
      const ta = env.bus.task_assignment;
      if (!ta.task_id || !ta.assign_to) {
        result.reason = 'missing task_id or assign_to';
        return result;
      }
      result.ok = true;
      result.detail = `task=${ta.task_id} → ${ta.assign_to}`;
      return result;
    }

    default:
      result.reason = `unknown action: ${step.action}`;
      return result;
  }
}

async function run(args) {
  if (args.length < 1) {
    console.error('Usage: peer-contract dry-run <scenario.yaml> [--reset-state]');
    return 2;
  }
  let scenarioPath = null;
  let resetState = false;
  for (const arg of args) {
    if (arg === '--reset-state') resetState = true;
    else if (!scenarioPath) scenarioPath = path.resolve(arg);
  }
  if (!scenarioPath) {
    console.error('Usage: peer-contract dry-run <scenario.yaml> [--reset-state]');
    return 2;
  }
  if (!fs.existsSync(scenarioPath)) {
    console.error(`Scenario file not found: ${scenarioPath}`);
    return 2;
  }

  // Optional: reset AC state before running (for reproducible test runs)
  if (resetState) {
    try {
      const ac = require('../lib/ac-tracker');
      const stateFile = ac.getStateFile();
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ chains: {} }, null, 2), 'utf-8');
      console.log(colorize('(reset AC state)', 'gray'));
    } catch (e) {
      console.error(`Failed to reset state: ${e.message}`);
      return 2;
    }
  }

  let scenario;
  try {
    scenario = yaml.parse(fs.readFileSync(scenarioPath, 'utf-8'));
  } catch (e) {
    console.error(`Cannot parse scenario YAML: ${e.message}`);
    return 2;
  }

  if (!scenario || !Array.isArray(scenario.steps)) {
    console.error('Scenario must have a "steps" array');
    return 2;
  }

  console.log(colorize(`=== Dry-run: ${scenario.name || path.basename(scenarioPath)} ===`, 'bold'));
  if (scenario.description) console.log(colorize(scenario.description, 'gray'));
  console.log('');

  const context = {};
  const results = [];
  const total = scenario.steps.length;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const r = await runStep(step, i + 1, total, context);
    const displayStep = { number: i + 1, total, label: step.label || step.action };
    console.log(formatDryRunStep(displayStep, r));
    results.push(r);
    if (!r.ok && step.halt_on_block !== false) {
      console.log(colorize('  (halting dry-run on BLOCK)', 'yellow'));
      break;
    }
  }

  console.log(formatDryRunSummary(scenario.steps, results));
  const allOk = results.every(r => r.ok);
  return allOk ? 0 : 1;
}

module.exports = { run };
