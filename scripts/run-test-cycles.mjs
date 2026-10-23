#!/usr/bin/env node
// Security Wave Live Danger Board: isolated tool test cycles.
//
// Runs ONLY in the workflow's test-cycles job: contents: read, checkout
// credentials not persisted, and no write token anywhere in that job. It
// reads the committed data/status.json, checks npm latest for each wave
// tool, and for every tool whose recorded test counts were produced on a
// different version it clones the release tag, runs npm ci and the tool's
// own test suite (see scripts/test-cycle.mjs), and writes the results as
// a JSON map { tool: result } to the --out path. The scan job downloads
// that file as a workflow artifact and scripts/update-data.mjs applies
// the results (TEST_RESULTS_PATH) instead of executing tool code in the
// job that holds the contents: write token.
//
// Usage: node scripts/run-test-cycles.mjs --out test-results/test-results.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runTestCycle } from "./test-cycle.mjs";

const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : "test-results/test-results.json";

const status = JSON.parse(readFileSync(join(process.cwd(), "data", "status.json"), "utf8"));

async function npmLatest(tool) {
  try {
    const res = await fetch(`https://registry.npmjs.org/@reneturcios%2f${tool}/latest`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.version ?? null;
  } catch { return null; }
}

const results = {};
for (const [tool, t] of Object.entries(status.tools ?? {})) {
  const latest = await npmLatest(tool);
  const target = latest ?? t.version ?? null;
  const prev = t.tests && typeof t.tests === "object" ? t.tests : null;
  const prevTested = prev?.tested_version ?? null;
  if (!target || prevTested === target) {
    console.log(`test cycle: ${tool} skipped (recorded counts already from v${prevTested ?? "none"}, target v${target ?? "unknown"})`);
    continue;
  }
  console.log(`test cycle: ${tool} v${target} (recorded counts were from ${prevTested ?? "no recorded version"})`);
  const res = runTestCycle(tool, target);
  results[tool] = res;
  console.log(`test cycle: ${tool} v${target} -> ${res.state}${res.total != null ? ` (${res.passed}/${res.total} passed)` : ""} in ${res.duration_s}s`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(results, null, 1) + "\n");
console.log(`wrote ${Object.keys(results).length} test result(s) to ${outPath}`);
