// src/commands/validate-schema.js
// Validate any JSON file against any schema file.

const fs = require('fs');
const path = require('path');
const { loadSchema } = require('../lib/schema-loader');
const { validate } = require('../lib/validator');
const { colorize } = require('../lib/reporter');

async function run(args) {
  if (args.length < 2) {
    console.error('Usage: peer-contract validate-schema <data.json> <schema.json>');
    return 2;
  }
  const dataPath = path.resolve(args[0]);
  const schemaPath = path.resolve(args[1]);

  if (!fs.existsSync(dataPath)) { console.error(`Data file not found: ${dataPath}`); return 2; }
  if (!fs.existsSync(schemaPath)) { console.error(`Schema file not found: ${schemaPath}`); return 2; }

  let data, schema;
  try { data = JSON.parse(fs.readFileSync(dataPath, 'utf-8')); }
  catch (e) { console.error(`Invalid JSON in data: ${e.message}`); return 1; }
  try { schema = loadSchema(schemaPath); }
  catch (e) { console.error(`Cannot load schema: ${e.message}`); return 2; }

  const errors = validate(data, schema, schemaPath);
  if (errors.length === 0) {
    console.log(colorize('OK', 'green') + ` ${dataPath} matches ${schemaPath}`);
    return 0;
  }
  console.log(colorize('BLOCK', 'red') + ` ${dataPath} does not match ${schemaPath} (${errors.length} errors)`);
  for (const err of errors) {
    console.log(`  ${colorize('×', 'red')} ${err.path}: ${err.message}`);
  }
  return 1;
}

module.exports = { run };
