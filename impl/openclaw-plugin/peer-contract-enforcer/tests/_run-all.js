#!/usr/bin/env node
// Top-level test runner. Replaces `npm test` for the plugin (which can fail under
// PowerShell + monorepo configs). Runs each test file sequentially, exits non-zero
// on any failure.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testFiles = [
  'hr9-work-toolset.test.mjs',
  'hr1-hr6-schema-validation.test.mjs',
  'hr4-hr7.test.mjs',
  'hr5-audit.test.mjs',
  'hr-e2e.test.mjs',
  'hr-day6a-followup.test.mjs',
  'role-registry-lifecycle.test.mjs',
  'hr5_1-bus-context.test.mjs',           // Day 8: HR5.1 bus-context-required
  'hr10-uuid-multitarget.test.mjs',       // Day 8 v2: HR10 UUID format + HR5.1 multi-target
];

let totalPassed = 0;
let totalFailed = 0;
let totalAsserts = 0;
let failedFiles = [];

for (const rel of testFiles) {
  const abs = join(here, rel);
  console.log(`\n=== Running ${rel} ===`);
  const r = spawnSync('node', [abs], { cwd: here, encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) {
    failedFiles.push(rel);
  }
  // Parse pass/fail counts. Two formats are supported:
  //   - "OK Passed: N / FAIL Failed: N" summary line (older test files)
  //   - "total: N" / per-OK-line / per-FAIL-line (newer test files, e.g. hr5_1, hr10)
  // We count both, then de-dupe to avoid double-counting in summary.

  // 1) Look for the "OK Passed: N" summary lines (older format)
  const passedMatch = r.stdout.match(/OK Passed:\s*(\d+)/g);
  if (passedMatch) {
    for (const m of passedMatch) {
      totalPassed += parseInt(m.match(/(\d+)/)[1], 10);
    }
  }
  const failedMatch = r.stdout.match(/FAIL Failed:\s*(\d+)/g);
  if (failedMatch) {
    for (const m of failedMatch) {
      totalFailed += parseInt(m.match(/(\d+)/)[1], 10);
    }
  }

  // 2) Look for "total: N" lines (newer test files like hr5_1-bus-context, hr10-uuid-multitarget
  //    use "OK <name>" / "FAIL <name>" / "# total: N" / "# pass: N fail: N" formats).
  //    These count as pass + total asserts (not double-counted with the older "OK Passed" summary).
  const totalMatch = r.stdout.match(/^\s*#\s*total:\s*(\d+)/m);
  if (totalMatch) {
    totalPassed += parseInt(totalMatch[1], 10);
    totalAsserts += parseInt(totalMatch[1], 10);
  }
  const passFailMatch = r.stdout.match(/^\s*#\s*pass:\s*(\d+)\s+fail:\s*(\d+)/m);
  if (passFailMatch) {
    totalAsserts += parseInt(passFailMatch[1], 10);
    totalFailed += parseInt(passFailMatch[2], 10);
  }
}

console.log('\n=== Summary ===');
console.log(`Total OK Passed: ${totalPassed}`);
console.log(`Total FAIL Failed: ${totalFailed}`);
if (failedFiles.length > 0) {
  console.log(`Failed files: ${failedFiles.join(', ')}`);
  process.exit(1);
}
process.exit(totalFailed > 0 ? 1 : 0);
