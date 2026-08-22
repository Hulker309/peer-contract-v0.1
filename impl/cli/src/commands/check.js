// src/commands/check.js
// Validate an envelope file against the v0.1 envelope schema.

const fs = require('fs');
const path = require('path');
const { loadByNameWithPath, loadSchema } = require('../lib/schema-loader');
const { validate } = require('../lib/validator');
const { formatCheckResult, colorize } = require('../lib/reporter');

async function run(args) {
  if (args.length < 1) {
    console.error('Usage: peer-contract check <envelope.json>');
    return 2;
  }
  const envelopePath = path.resolve(args[0]);
  if (!fs.existsSync(envelopePath)) {
    console.error(`File not found: ${envelopePath}`);
    return 2;
  }

  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
  } catch (e) {
    console.error(`Invalid JSON in ${envelopePath}: ${e.message}`);
    return 1;
  }

  // Load envelope schema (with abs path for $ref resolution)
  let schema, schemaPath;
  try {
    const loaded = loadByNameWithPath('99-envelope');
    schema = loaded.schema;
    schemaPath = loaded.absPath;
  } catch (e) {
    console.error(`Cannot load envelope schema: ${e.message}`);
    return 2;
  }

  // Validate
  const errors = validate(envelope, schema, schemaPath);
  const warnings = [];

  // Size cap check (HR8)
  const sizeBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf-8');
  const sizeLimit = 65536;
  if (sizeBytes > sizeLimit) {
    errors.push({ path: 'size_cap.current_bytes', message: `envelope size ${sizeBytes} exceeds HR8 cap ${sizeLimit}` });
  }

  // Version check
  if (envelope.version !== '0.1.0') {
    errors.push({ path: 'version', message: `unsupported version: ${envelope.version} (expected 0.1.0)` });
  }

  // Cross-field: envelope_id == routing.dispatch_id
  if (envelope.envelope_id && envelope.routing && envelope.envelope_id !== envelope.routing.dispatch_id) {
    errors.push({ path: 'envelope_id', message: `envelope_id ${envelope.envelope_id} != routing.dispatch_id ${envelope.routing.dispatch_id}` });
  }

  // Friendly rule references in error messages
  const decorated = errors.map(e => {
    let msg = e.message;
    if (e.path.startsWith('routing.target_session_key') && msg.includes('pattern')) msg += ' (HR1 enforcement)';
    if (e.path.startsWith('routing.target_role') && e.path.includes('work') && msg.includes('enum')) msg += ' (HR2/HR3 enforcement)';
    if (e.path.startsWith('size_cap')) msg += ' (HR8)';
    return { ...e, message: msg };
  });

  const result = {
    ok: decorated.length === 0,
    errors: decorated,
    warnings,
    sizeBytes,
    sizeLimit,
  };
  console.log(formatCheckResult(result));
  return result.ok ? 0 : 1;
}

module.exports = { run };
