// Shared tool test-cycle runner for the Live Danger Board pipeline.
//
// A test cycle clones a tool's release tag, runs npm ci and the tool's own
// test suite, and returns the recorded result. This executes code from the
// tool repos, so in the workflow it runs ONLY in the isolated test-cycles
// job (contents: read, checkout credentials not persisted, no write token
// in scope). scripts/update-data.mjs never executes a cycle itself when
// TEST_RESULTS_PATH is set; it applies the results this module produced in
// that isolated job. Run standalone in this module's home repo context it
// behaves exactly as the pre-split pipeline did.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 120000, maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd });
  return r;
}

export function parseTestCounts(text) {
  // node:test summary lines, in both reporter shapes the runner emits:
  // TAP ("# tests 21") and spec ("ℹ tests 21"). Either is authoritative.
  const grab = (label) => {
    const m = text.match(new RegExp(`^[#\\u2139] ${label} (\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const total = grab("tests"), passed = grab("pass"), failed = grab("fail");
  if (total != null && passed != null && failed != null) return { total, passed, failed };
  const ok = (text.match(/^ok \d+/gm) || []).length;
  const notOk = (text.match(/^not ok \d+/gm) || []).length;
  if (ok + notOk > 0) return { total: ok + notOk, passed: ok, failed: notOk };
  return null;
}

export function runTestCycle(tool, version) {
  const started = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), "swtest-"));
  const dest = join(tmp, "repo");
  const done = (state, extra = {}) => ({
    state, passed: null, failed: null, total: null, ...extra,
    tested_version: version, tested_at: nowIso(),
    duration_s: Math.round((Date.now() - started) / 100) / 10,
  });
  try {
    const clone = run("git", ["clone", "-q", "--depth", "1", "--branch", `v${version}`, `https://github.com/CloudCorpRecords/${tool}.git`, dest], { timeout: 300000 });
    if (clone.status !== 0) return done("error", { error: `clone of tag v${version} failed` });
    const ci = run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { timeout: 480000, cwd: dest });
    if (ci.status !== 0) return done("error", { error: "npm ci failed on the release tag" });
    const t = run("npm", ["test", "--silent"], { timeout: 600000, cwd: dest });
    const counts = parseTestCounts(`${t.stdout ?? ""}\n${t.stderr ?? ""}`);
    if (t.error || t.status == null) return done("error", { error: "test run timed out or was killed", ...(counts ?? {}) });
    if (!counts) return done("error", { error: "test output unparsable (no test summary)" });
    return done(counts.failed === 0 && t.status === 0 ? "pass" : "fail", counts);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
