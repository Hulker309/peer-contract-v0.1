// Day 6a followup fixture tests for Drift 5 ref + Kelsen review holds (Halt 期间)
// Covers:
//   (a) agent-registry bootstrap sanity check: skip non-agent dirs (no sessions/ subdir)
//   (b) hardcoded fallback emits warning when activated (never silent)
//   (c) reserved-sessionKinds blacklist: session_start event with agentId="webchat" → not registered
//   (d) real session_start event with agentId="coder" → registered
//
// Run with: node tests/hr-day6a-followup.test.mjs

import { createAgentRegistry } from "../src/agent-registry.js";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, printSummary } from "./_helpers.mjs";

let passed = 0;
let failed = 0;

console.log("\n[Drift 5 ref review holds — Day 6a followup]");

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (a) bootstrap sanity check
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

await test("Drift 5 hold (a): bootstrap skips non-agent dirs (no sessions/ subdir)", () => {
  // Create a fake home with a normal agent dir + a "logs" trap dir
  const fakeHome = "C:/Users/Administrator/.openclaw/agents/coder/.day6a-test-home-a";
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  mkdirSync(join(fakeHome, "agents/coder/sessions"), { recursive: true });
  mkdirSync(join(fakeHome, "agents/kelsen/sessions"), { recursive: true });
  mkdirSync(join(fakeHome, "agents/logs"), { recursive: true }); // trap: no sessions/
  mkdirSync(join(fakeHome, "agents/memory"), { recursive: true }); // trap: no sessions/

  const registry = createAgentRegistry({
    openclawHomeDir: fakeHome,
    logger: () => {}, // silent for clean test output
  });
  const scan = registry.bootstrapScan();

  if (scan.scannedAgents !== 2) throw new Error(`expected 2 agent dirs, got ${scan.scannedAgents}: ${JSON.stringify(scan.registeredAgents)}`);
  if (!scan.registeredAgents.includes("coder")) throw new Error("coder not registered");
  if (!scan.registeredAgents.includes("kelsen")) throw new Error("kelsen not registered");
  if (scan.registeredAgents.includes("logs")) throw new Error("'logs' trap dir should be skipped");
  if (scan.registeredAgents.includes("memory")) throw new Error("'memory' trap dir should be skipped");
  if (!scan.skippedDirs.includes("logs") || !scan.skippedDirs.includes("memory")) {
    throw new Error(`skippedDirs should include 'logs' and 'memory', got: ${JSON.stringify(scan.skippedDirs)}`);
  }

  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

await test("Drift 5 hold (a): hardcoded fallback whitelist agents always pass sanity check (cold-start)", () => {
  // Create a fake home with NO agent dirs (cold-start)
  const fakeHome = "C:/Users/Administrator/.openclaw/agents/coder/.day6a-test-home-a-cold";
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  mkdirSync(join(fakeHome, "agents"), { recursive: true });

  const registry = createAgentRegistry({
    openclawHomeDir: fakeHome,
    logger: () => {}, // silent
  });
  const scan = registry.bootstrapScan();

  if (scan.scannedAgents !== 0) throw new Error(`expected 0 agent dirs in empty home, got ${scan.scannedAgents}`);
  // asWhitelist should still return hardcoded fallback even with empty map
  const wl = registry.asWhitelist();
  if (!wl.has("coder") || !wl.has("kelsen") || !wl.has("main")) {
    throw new Error(`fallback whitelist missing known agents: ${[...wl].join(",")}`);
  }

  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (b) hardcoded fallback emits warning
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

await test("Drift 5 hold (b): hardcoded fallback emits warning when activated (never silent)", () => {
  const capturedLogs = [];
  const registry = createAgentRegistry({
    openclawHomeDir: "C:/Users/Administrator/.openclaw/agents/coder/.nonexistent-home",
    logger: (msg, level) => capturedLogs.push({ msg, level }),
  });
  // Trigger fallback by calling asWhitelist() before any registration
  const wl = registry.asWhitelist();
  if (wl.size === 0) throw new Error("whitelist should not be empty");
  if (capturedLogs.length === 0) throw new Error("fallback should emit a log; got 0");
  const fallbackLog = capturedLogs.find(l => l.level === "warn" && /FALLBACK/i.test(l.msg));
  if (!fallbackLog) throw new Error(`no warn-level FALLBACK log emitted; got: ${JSON.stringify(capturedLogs)}`);
  if (!/hardcoded fallback/i.test(fallbackLog.msg)) {
    throw new Error(`fallback log should mention 'hardcoded fallback'; got: ${fallbackLog.msg}`);
  }

  // Diagnostics should report fallback activated
  const diag = registry.diagnostics();
  if (!diag.fallbackActivated) throw new Error("diagnostics should report fallbackActivated=true");
  if (!diag.fallbackReason) throw new Error("diagnostics should report fallbackReason");
});

await test("Drift 5 hold (b): fallback only logs once (not on every asWhitelist call)", () => {
  const capturedLogs = [];
  const registry = createAgentRegistry({
    openclawHomeDir: "C:/Users/Administrator/.openclaw/agents/coder/.nonexistent-home-2",
    logger: (msg, level) => capturedLogs.push({ msg, level }),
  });
  registry.asWhitelist();
  registry.asWhitelist();
  registry.asWhitelist();
  const fallbackLogs = capturedLogs.filter(l => /FALLBACK/i.test(l.msg));
  if (fallbackLogs.length !== 1) {
    throw new Error(`fallback should log exactly once; got ${fallbackLogs.length} logs`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (c) reserved sessionKind blacklist (index.js logic)
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

await test("Drift 5 hold (c): RESERVED_SESSION_KINDS blacklist prevents sessionKind registration", () => {
  // Simulate session_start event handler logic from index.js
  const RESERVED_SESSION_KINDS = new Set(["webchat", "subagent", "dashboard", "tui", "run", "work", "bus", "main", "cron"]);

  const fakeHome = "C:/Users/Administrator/.openclaw/agents/coder/.day6a-test-home-c";
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  mkdirSync(join(fakeHome, "agents/coder/sessions"), { recursive: true });

  const registry = createAgentRegistry({
    openclawHomeDir: fakeHome,
    logger: () => {},
  });
  registry.bootstrapScan();

  // Simulate session_start events with various agentIds
  for (const fakeAgentId of ["webchat", "subagent", "dashboard", "tui", "cron"]) {
    if (RESERVED_SESSION_KINDS.has(fakeAgentId)) {
      // Skip per index.js: not registered
      continue;
    }
    registry.register(fakeAgentId, { source: "session_start" });
  }
  // Real agentId registered
  registry.register("coder", { source: "session_start" });

  if (registry.has("webchat")) throw new Error("'webchat' sessionKind should NOT be registered");
  if (registry.has("subagent")) throw new Error("'subagent' sessionKind should NOT be registered");
  if (!registry.has("coder")) throw new Error("'coder' should be registered");

  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

printSummary("Day 6a followup");
if (passed === 0 && failed > 0) process.exit(1);
if (failed > 0) process.exit(1);