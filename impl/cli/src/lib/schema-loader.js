// src/lib/schema-loader.js
// Loads and caches JSON Schemas from the spec/ directory.
// Resolves $ref against other schema files in the same directory.

const fs = require('fs');
const path = require('path');

let cache = new Map(); // path -> { schema, absPath }

function clearCache() {
  cache = new Map();
}

function loadSchema(schemaPath) {
  const abs = path.resolve(schemaPath);
  if (cache.has(abs)) return cache.get(abs).schema;

  const raw = fs.readFileSync(abs, 'utf-8');
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in schema ${abs}: ${e.message}`);
  }
  cache.set(abs, { schema, absPath: abs });
  return schema;
}

function getAbsPath(schemaPath) {
  return path.resolve(schemaPath);
}

function resolveRef(ref, basePath) {
  // Support local refs like "01-dispatch.schema.json" or "../spec/01-dispatch.schema.json"
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    throw new Error(`External $ref not supported: ${ref}. Use local file paths.`);
  }
  if (!basePath || basePath === '<schema>' || basePath === '.' || !fs.existsSync(basePath)) {
    // basePath not provided - try to resolve against default spec dir
    const defaultDir = getSchemaDir();
    const resolved = path.resolve(defaultDir, ref);
    return loadSchema(resolved);
  }
  const resolved = path.resolve(path.dirname(basePath), ref);
  return loadSchema(resolved);
}

function getSchemaDir() {
  // Default schema dir is ../../../spec relative to this lib file
  // __dirname = impl/cli/src/lib, so 4 levels up = peer-contract-v0.1, then /spec
  return path.resolve(__dirname, '..', '..', '..', '..', 'spec');
}

function loadByName(name) {
  // name like "01-dispatch" or "99-envelope"
  const schemaPath = path.join(getSchemaDir(), `${name}.schema.json`);
  return loadSchema(schemaPath);
}

function loadByNameWithPath(name) {
  const schemaPath = path.join(getSchemaDir(), `${name}.schema.json`);
  const abs = path.resolve(schemaPath);
  return { schema: loadSchema(abs), absPath: abs };
}

module.exports = {
  loadSchema,
  resolveRef,
  loadByName,
  loadByNameWithPath,
  getSchemaDir,
  getAbsPath,
  clearCache,
};
