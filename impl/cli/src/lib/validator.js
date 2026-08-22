// src/lib/validator.js
// Minimal JSON Schema 2020-12 validator. Supports the subset used by peer-contract v0.1.
// NOT a full JSON Schema implementation - this is a focused validator for our specific schemas.
//
// Supported: type, required, additionalProperties, properties, enum, const, pattern,
//             minLength, maxLength, minimum, maximum, format (uuid, date-time, email),
//             $ref (local files), allOf, anyOf, oneOf, if/then/else, items, examples (ignored).

const schemaLoader = require('./schema-loader');
const { resolveRef } = schemaLoader;

function isObject(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

function formatPath(path) {
  if (!path || path.length === 0) return '<root>';
  return path.join('.');
}

function validateFormat(value, format) {
  if (format === 'uuid') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }
  if (format === 'date-time') {
    // ISO 8601 - allow Z or +/-HH:MM, and milliseconds
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
  }
  if (format === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  return true; // unknown format, accept
}

function validateValue(value, schema, basePath, baseSchemaPath) {
  const errors = [];
  const currentPath = basePath;

  // $ref resolution
  if (schema.$ref) {
    const refSchema = resolveRef(schema.$ref, baseSchemaPath);
    // Determine the absolute path of the resolved ref schema
    let refPath;
    if (baseSchemaPath && baseSchemaPath !== '<schema>' && baseSchemaPath !== '.') {
      const path = require('path');
      refPath = path.resolve(path.dirname(baseSchemaPath), schema.$ref);
    } else {
      // baseSchemaPath was default; resolveRef fell back to default dir
      const path = require('path');
      const defaultDir = schemaLoader.getSchemaDir();
      refPath = path.resolve(defaultDir, schema.$ref);
    }
    return validateValue(value, refSchema, currentPath, refPath);
  }

  // const
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      errors.push({ path: formatPath(basePath), message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
    }
  }

  // not (negation)
  if (schema.not !== undefined) {
    const notErrors = validateValue(value, schema.not, basePath, baseSchemaPath);
    if (notErrors.length === 0) {
      errors.push({ path: formatPath(basePath), message: `value must NOT match the not schema` });
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push({ path: formatPath(basePath), message: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}` });
    }
  }

  // type check
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let actualType;
    if (value === null) actualType = 'null';
    else if (Array.isArray(value)) actualType = 'array';
    else if (value instanceof Date) actualType = 'string';
    else actualType = typeof value;
    // Special case: integer is a JSON Schema type but JS typeof returns 'number' for both
    if (types.includes('integer') && actualType === 'number') {
      if (Number.isInteger(value)) {
        actualType = 'integer';
      }
    }
    if (!types.includes(actualType)) {
      errors.push({ path: formatPath(basePath), message: `expected type ${types.join('|')}, got ${actualType}` });
      return errors; // can't continue without correct type
    }
  }

  // string constraints
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: formatPath(basePath), message: `string length ${value.length} < minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path: formatPath(basePath), message: `string length ${value.length} > maxLength ${schema.maxLength}` });
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      errors.push({ path: formatPath(basePath), message: `does not match pattern ${schema.pattern}` });
    }
    if (schema.format && !validateFormat(value, schema.format)) {
      errors.push({ path: formatPath(basePath), message: `invalid format ${schema.format}: ${value}` });
    }
  }

  // number constraints
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path: formatPath(basePath), message: `${value} < minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path: formatPath(basePath), message: `${value} > maximum ${schema.maximum}` });
    }
  }

  // array constraints
  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateValue(item, schema.items, [...basePath, String(i)], baseSchemaPath));
      });
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: formatPath(basePath), message: `array length ${value.length} < minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path: formatPath(basePath), message: `array length ${value.length} > maxItems ${schema.maxItems}` });
    }
  }

  // object constraints
  if (isObject(value)) {
    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in value)) {
          errors.push({ path: formatPath(basePath), message: `missing required field: ${req}` });
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push({ path: formatPath([...basePath, key]), message: `additional property not allowed: ${key}` });
        }
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          // Recurse into property value AND run conditional checks on the property schema
          errors.push(...validateValue(value[key], propSchema, [...basePath, key], baseSchemaPath));
          errors.push(...validateConditional(value[key], propSchema, [...basePath, key], baseSchemaPath));
        }
      }
    }
  }

  // Also run conditional checks at this level (catches allOf/if/then/else on current schema)
  errors.push(...validateConditional(value, schema, basePath, baseSchemaPath));

  return errors;
}

function validateConditional(value, schema, basePath, baseSchemaPath) {
  // allOf, anyOf, oneOf, if/then/else
  const errors = [];
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      errors.push(...validateValue(value, sub, basePath, baseSchemaPath));
    }
  }
  if (schema.anyOf) {
    const anyOk = schema.anyOf.some(sub => validateValue(value, sub, basePath, baseSchemaPath).length === 0);
    if (!anyOk && schema.anyOf.length > 0) {
      errors.push({ path: formatPath(basePath), message: `value does not match any of the anyOf schemas` });
    }
  }
  if (schema.oneOf) {
    const okCount = schema.oneOf.filter(sub => validateValue(value, sub, basePath, baseSchemaPath).length === 0).length;
    if (okCount !== 1) {
      errors.push({ path: formatPath(basePath), message: `value matches ${okCount} of oneOf schemas, expected exactly 1` });
    }
  }
  if (schema.if) {
    const ifErrors = validateValue(value, schema.if, basePath, baseSchemaPath);
    const conditionMet = ifErrors.length === 0;
    if (conditionMet && schema.then) {
      errors.push(...validateValue(value, schema.then, basePath, baseSchemaPath));
    } else if (!conditionMet && schema.else) {
      errors.push(...validateValue(value, schema.else, basePath, baseSchemaPath));
    }
  }
  return errors;
}

// Main entry
function validate(value, schema, schemaPath) {
  const basePath = schemaPath || '<schema>';
  let errors = validateValue(value, schema, [], basePath);
  // Note: validateValue now calls validateConditional internally at every level,
  // so we don't need a separate top-level call here.
  return errors;
}

module.exports = { validate, validateValue, validateFormat };
