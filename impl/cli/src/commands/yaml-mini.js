// src/commands/yaml-mini.js
// Tiny YAML subset reader. Supports the limited syntax used in our scenarios.
// NOT a full YAML parser - just enough for our use case (lists of objects with simple key-value pairs and nested objects).
// Why not depend on js-yaml? Zero deps principle. Our scenarios are simple and controlled.

function parseScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Inline array: [a, b, c]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(item => parseScalar(item.trim()));
  }
  // Inline object: {key: value, key2: value2}
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return {};
    const obj = {};
    inner.split(',').forEach(pair => {
      const colonIdx = pair.indexOf(':');
      if (colonIdx > 0) {
        const k = pair.slice(0, colonIdx).trim();
        const v = pair.slice(colonIdx + 1).trim();
        obj[k] = parseScalar(v);
      }
    });
    return obj;
  }
  return s;
}

function parse(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, container: root, isArray: false }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and blank
    if (/^\s*(#|$)/.test(line)) continue;

    const indentMatch = line.match(/^(\s*)(.*)$/);
    const indent = indentMatch[1].length;
    const content = indentMatch[2];

    // Pop stack to current indent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];

    if (content.startsWith('- ')) {
      // Array item
      const rest = content.slice(2);
      if (!top.isArray) {
        // Convert container to array if needed - shouldn't happen with our scenarios
        continue;
      }
      if (rest.includes(':')) {
        // Object item starting with key
        const colonIdx = rest.indexOf(':');
        const key = rest.slice(0, colonIdx).trim();
        const valStr = rest.slice(colonIdx + 1).trim();
        const item = {};
        if (valStr) {
          item[key] = parseScalar(valStr);
        } else {
          item[key] = null;
        }
        top.container.push(item);
        // Push item so subsequent deeper keys are added to it
        // Item is at logical indent = current indent (the `- ` line)
        stack.push({ indent, container: item, isArray: false });
      } else {
        top.container.push(parseScalar(rest));
      }
    } else if (content.includes(':')) {
      // Key: value
      const colonIdx = content.indexOf(':');
      const key = content.slice(0, colonIdx).trim();
      const valStr = content.slice(colonIdx + 1).trim();
      if (valStr === '') {
        // Will be array or object on next lines
        // Peek at next non-blank line
        let nextIdx = i + 1;
        while (nextIdx < lines.length && /^\s*(#|$)/.test(lines[nextIdx])) nextIdx++;
        if (nextIdx < lines.length) {
          const nextIndent = lines[nextIdx].match(/^(\s*)/)[1].length;
          if (nextIndent > indent) {
            // Determine array vs object from next content
            if (/^\s*-\s/.test(lines[nextIdx])) {
              const newArr = [];
              top.container[key] = newArr;
              stack.push({ indent, container: newArr, isArray: true });
            } else {
              const newObj = {};
              top.container[key] = newObj;
              stack.push({ indent, container: newObj, isArray: false });
            }
          } else {
            top.container[key] = null;
          }
        } else {
          top.container[key] = null;
        }
      } else {
        top.container[key] = parseScalar(valStr);
      }
    }
  }
  return root;
}

module.exports = { parse, parseScalar };
