#!/usr/bin/env node
// Security Wave Live Danger Board: scheduled data pipeline.
//
// Runs in GitHub Actions every 15 minutes (and on workflow_dispatch).
// What it does, using only public sources:
//   1. Reads npm latest versions for the four wave tools. A version change
//      becomes a "release" event in data/events.json.
//   2. Re-scans the factory watchlist (data/status.json > watchlist) with the
//      published actionpin and hookcheck binaries and diffs against the
//      stored grid: verdict changes, pin regressions, and RISKY finding
//      deltas become events. Our own repos are named; nothing external is
//      scanned by the scheduled run.
//   3. An optional EXTRA_REPO (workflow_dispatch input, our namespace only)
//      is scanned once and always reported in the feed, so a manual test is
//      visible whether or not it is clean.
//   4. Events are capped at the newest 500; overflow is archived by month
//      under data/archive/.
//   5. The slow-moving numbers are derived, never hand-exported: the
//      problem-ledger counters are parsed from ledger/problems.md and the
//      corpus / coverage / round figures from ledger/program.md, both
//      committed records in this repo (scripts/parse-records.mjs). A parse
//      failure keeps the last good values and flags them stale.
//   6. Test counts: when a tool's npm version differs from the version its
//      recorded counts were produced on, the pipeline clones that release
//      tag, runs npm ci and the tool's own test suite, and records the
//      result. A failing suite is a danger event in the feed, never stale
//      green. See SELF-UPDATE.md for the whole loop.
//   7. Isolation: the test cycles in step 6 execute code from the tool
//      repos, so in the workflow they run in a separate job with
//      contents: read and no persisted credentials (scripts/
//      run-test-cycles.mjs). This script then runs with TEST_RESULTS_PATH
//      pointing at that job's artifact and only APPLIES the recorded
//      results; it executes no tool code itself. Without TEST_RESULTS_PATH
//      (local runs) it runs the cycles inline as before.
//
// Files are rewritten only when something actually changed, so the workflow
// commits only on change. No dependencies beyond Node >= 20 and git.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLedger, parseProgram } from "./parse-records.mjs";
import { runTestCycle } from "./test-cycle.mjs";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");
const STATUS_PATH = join(DATA, "status.json");
const EVENTS_PATH = join(DATA, "events.json");
const MAX_EVENTS = 500;

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const saveJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 1) + "\n");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 120000, maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd });
  return r;
}

function gitCommitTime(path) {
  const r = run("git", ["log", "-1", "--format=%cI", "--", path], { timeout: 30000 });
  if (r.status === 0) {
    const s = (r.stdout || "").trim();
    if (s) return s;
  }
  return null;
}

function scanRepo(fullName) {
  // Returns {head, actionpin:{...}|null, hookcheck:{...}|null} or null on clone failure.
  const tmp = mkdtempSync(join(tmpdir(), "swscan-"));
  const dest = join(tmp, "repo");
  try {
    const clone = run("git", ["clone", "-q", "--depth", "1", `https://github.com/${fullName}.git`, dest], { timeout: 240000 });
    if (clone.status !== 0) {
      console.log(`clone failed for ${fullName}: ${(clone.stderr || "").slice(0, 200)}`);
      return null;
    }
    const head = (run("git", ["-C", dest, "rev-parse", "HEAD"]).stdout || "").trim().slice(0, 12);
    const out = { head };
    const ap = run("actionpin", ["audit", dest, "--json"]);
    try {
      const d = JSON.parse(ap.stdout);
      out.actionpin = { verdict: d.verdict, total: d.counts.total, pinned: d.counts.pinned,
        mutable: d.counts.mutable, branch: d.counts.branch, local: d.counts.local,
        checked_at: d.checkedAt ?? nowIso() };
    } catch { console.log(`actionpin output unparsable for ${fullName}`); out.actionpin = null; }
    const hc = run("hookcheck", ["scan", dest, "--json"]);
    try {
      const d = JSON.parse(hc.stdout);
      const rules = {};
      for (const f of d.findings ?? []) {
        const sev = (f.severity ?? "").toLowerCase();
        if (sev === "risky" || sev === "high") {
          const rule = f.rule ?? f.id ?? f.kind ?? "unknown";
          rules[rule] = (rules[rule] ?? 0) + 1;
        }
      }
      out.hookcheck = { verdict: d.verdict, total: d.counts.total, safe: d.counts.safe,
        risky: d.counts.risky, unknown: d.counts.unknown, checked_at: d.scannedAt ?? nowIso(),
        risky_rules: rules };
    } catch { console.log(`hookcheck output unparsable for ${fullName}`); out.hookcheck = null; }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function npmLatest(tool) {
  try {
    const res = await fetch(`https://registry.npmjs.org/@reneturcios%2f${tool}/latest`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.version ?? null;
  } catch { return null; }
}

const status = loadJson(STATUS_PATH);
const eventsDoc = loadJson(EVENTS_PATH);
const events = eventsDoc.events ?? [];
const haveEvent = new Set(events.map((e) => e.id));
let changed = false;
const newEvents = [];
const stamp = nowIso();

function addEvent(ev) {
  if (haveEvent.has(ev.id)) return;
  haveEvent.add(ev.id);
  newEvents.push(ev);
  changed = true;
  console.log(`event: ${ev.type} ${ev.title}`);
}

// 0. committed records: parse the ledger and the program record fresh.
// The validation process commits updates to ledger/problems.md and
// ledger/program.md as its work closes; everything downstream of those
// commits is automatic. Parse failures keep the last good values, flagged
// stale, and never blank a section.
try {
  const parsed = parseLedger(readFileSync(join(ROOT, "ledger", "problems.md"), "utf8"));
  const prev = status.ledger ?? {};
  const next = {
    source: "ledger/problems.md in this repo (the public ledger of record), parsed by scripts/parse-records.mjs on every pipeline run",
    as_of: gitCommitTime("ledger/problems.md") ?? prev.as_of ?? null,
    ...parsed, stale: false,
  };
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    status.ledger = next;
    changed = true;
    console.log(`ledger counters refreshed: ${parsed.found} found, ${parsed.fixed} fixed, ${parsed.open_total} open`);
  }
} catch (e) {
  console.log(`ledger parse failed, keeping last good values flagged stale: ${e.message}`);
  if (status.ledger && !status.ledger.stale) { status.ledger = { ...status.ledger, stale: true }; changed = true; }
}
try {
  const parsed = parseProgram(readFileSync(join(ROOT, "ledger", "program.md"), "utf8"));
  const asOf = gitCommitTime("ledger/program.md") ?? status.corpus?.as_of ?? null;
  const blocks = [
    ["corpus", { ...parsed.corpus, as_of: asOf, stale: false }],
    ["coverage", { ...parsed.coverage, stale: false }],
    ["rounds", { ...parsed.rounds, stale: false }],
  ];
  for (const [key, next] of blocks) {
    if (JSON.stringify(next) !== JSON.stringify(status[key] ?? {})) {
      status[key] = next;
      changed = true;
      console.log(`program record refreshed: ${key}`);
    }
  }
} catch (e) {
  console.log(`program record parse failed, keeping last good values flagged stale: ${e.message}`);
  for (const key of ["corpus", "coverage", "rounds"]) {
    if (status[key] && !status[key].stale) { status[key] = { ...status[key], stale: true }; changed = true; }
  }
}

// 1. npm version watch
for (const tool of Object.keys(status.tools ?? {})) {
  const latest = await npmLatest(tool);
  const recorded = status.tools[tool].version;
  if (latest && recorded && latest !== recorded) {
    addEvent({
      id: `rel-${tool}-${latest}`, ts: stamp, type: "release", severity: "low",
      scope: "own", tool, repo: `CloudCorpRecords/${tool}`,
      title: `${tool} v${latest} shipped`,
      detail: `npm latest moved from v${recorded} to v${latest}. Detected by the scheduled scan from the npm registry; see the tool repo for the release notes.`,
    });
    status.tools[tool].version = latest;
    changed = true;
  }
}

// 2. watchlist scans
const severityForVerdict = (tool, verdict) => {
  if (tool === "hookcheck" && verdict === "COMPROMISED-PATTERN") return "critical";
  if (verdict === "EXPOSED" || verdict === "FINDINGS") return "high";
  if (verdict === "REVIEW" || verdict === "PARTIAL") return "medium";
  return "resolved";
};

for (const entry of status.watchlist ?? []) {
  const scan = scanRepo(entry.repo);
  if (!scan) continue;
  const short = entry.repo.split("/")[1];
  if (scan.actionpin) {
    const prev = entry.actionpin ?? {};
    const cur = scan.actionpin;
    if (prev.verdict && cur.verdict !== prev.verdict) {
      addEvent({
        id: `vc-${short}-actionpin-${cur.verdict}-${stamp.slice(0, 13)}`, ts: stamp,
        type: "verdict_change", severity: severityForVerdict("actionpin", cur.verdict),
        scope: "own", tool: "actionpin", repo: entry.repo,
        title: `${short}: actionpin verdict ${prev.verdict} to ${cur.verdict}`,
        detail: `Now ${cur.pinned} pinned, ${cur.mutable} mutable, ${cur.branch} branch refs of ${cur.total} actions at head ${scan.head}.`,
      });
    }
    const prevMutable = (prev.mutable ?? 0) + (prev.branch ?? 0);
    const curMutable = cur.mutable + cur.branch;
    if (prev.verdict && curMutable > prevMutable) {
      addEvent({
        id: `pinreg-${short}-${prevMutable}-${curMutable}-${stamp.slice(0, 13)}`, ts: stamp,
        type: "pin_regression", severity: "high", scope: "own", tool: "actionpin", repo: entry.repo,
        title: `${short}: pin regression, ${curMutable - prevMutable} new mutable action ref${curMutable - prevMutable === 1 ? "" : "s"}`,
        detail: `Mutable plus branch refs rose from ${prevMutable} to ${curMutable} at head ${scan.head}. A mutable ref is the tj-actions shape: the tag can be retargeted after review.`,
      });
    }
    entry.actionpin = { verdict: cur.verdict, total: cur.total, pinned: cur.pinned,
      mutable: cur.mutable, branch: cur.branch, local: cur.local, checked_at: cur.checked_at };
    if (JSON.stringify(entry.actionpin) !== JSON.stringify(prev)) changed = true;
  }
  if (scan.hookcheck) {
    const prev = entry.hookcheck ?? {};
    const cur = scan.hookcheck;
    if (prev.verdict && cur.verdict !== prev.verdict) {
      addEvent({
        id: `vc-${short}-hookcheck-${cur.verdict}-${stamp.slice(0, 13)}`, ts: stamp,
        type: "verdict_change", severity: severityForVerdict("hookcheck", cur.verdict),
        scope: "own", tool: "hookcheck", repo: entry.repo,
        title: `${short}: hookcheck verdict ${prev.verdict} to ${cur.verdict}`,
        detail: `Now ${cur.total} inventoried hooks and steps: ${cur.safe} SAFE, ${cur.risky} RISKY, ${cur.unknown} UNKNOWN at head ${scan.head}.`,
      });
    }
    if (typeof prev.risky === "number" && cur.risky > prev.risky) {
      const rules = Object.entries(cur.risky_rules ?? {}).sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r} x${n}`).join(", ");
      addEvent({
        id: `find-${short}-hookcheck-${prev.risky}-${cur.risky}-${stamp.slice(0, 13)}`, ts: stamp,
        type: "finding_detected", severity: "high", scope: "own", tool: "hookcheck", repo: entry.repo,
        title: `${short}: ${cur.risky - prev.risky} new RISKY finding${cur.risky - prev.risky === 1 ? "" : "s"} from hookcheck`,
        detail: `RISKY count rose from ${prev.risky} to ${cur.risky} at head ${scan.head}${rules ? `. Rule families now at RISKY: ${rules}` : ""}.`,
      });
    }
    if (typeof prev.risky === "number" && cur.risky < prev.risky) {
      addEvent({
        id: `res-${short}-hookcheck-${prev.risky}-${cur.risky}-${stamp.slice(0, 13)}`, ts: stamp,
        type: "finding_resolved", severity: "resolved", scope: "own", tool: "hookcheck", repo: entry.repo,
        title: `${short}: RISKY findings down from ${prev.risky} to ${cur.risky}`,
        detail: `hookcheck re-scan at head ${scan.head}. Verdict now ${cur.verdict}.`,
      });
    }
    const slim = { verdict: cur.verdict, total: cur.total, safe: cur.safe, risky: cur.risky,
      unknown: cur.unknown, checked_at: cur.checked_at };
    if (JSON.stringify(slim) !== JSON.stringify(prev)) changed = true;
    entry.hookcheck = slim;
  }
  if (scan.head && scan.head !== entry.head) { entry.head = scan.head; changed = true; }
}

// 3. optional manual extra repo scan (workflow_dispatch), our namespace only.
const extra = (process.env.EXTRA_REPO ?? "").trim();
if (extra && /^CloudCorpRecords\/[\w.-]+$/.test(extra) && !(status.watchlist ?? []).some((w) => w.repo === extra)) {
  const scan = scanRepo(extra);
  if (scan) {
    const ap = scan.actionpin, hc = scan.hookcheck;
    const mutable = ap ? ap.mutable + ap.branch : 0;
    const risky = hc ? hc.risky : 0;
    const bad = mutable > 0 || risky > 0 || (hc && hc.verdict === "COMPROMISED-PATTERN");
    addEvent({
      id: `extra-${extra.split("/")[1]}-${stamp}`, ts: stamp,
      type: bad ? "finding_detected" : "program", severity: bad ? "high" : "low",
      scope: "own", tool: null, repo: extra,
      title: bad ? `Manual watch scan: ${extra} needs attention` : `Manual watch scan: ${extra} clean at current rules`,
      detail: `Dispatched manually. actionpin: ${ap ? `${ap.verdict}, ${ap.pinned} pinned, ${ap.mutable} mutable, ${ap.branch} branch of ${ap.total}` : "unavailable"}. hookcheck: ${hc ? `${hc.verdict}, ${hc.total} inventoried, ${hc.risky} RISKY` : "unavailable"}. Head ${scan.head}.`,
    });
  } else {
    console.log(`extra repo scan failed: ${extra}`);
  }
}

// 5. test cycles: for each tool, if the recorded test counts were produced
// on a different version than the current npm latest, clone the release
// tag, npm ci, and run the tool's own test suite. Counts on the board are
// always produced by this pipeline from the published tag, never typed in.
// A failed or errored cycle is recorded as a failed state and appends a
// danger event; it never silently keeps the previous green.
// The cycle runner itself lives in scripts/test-cycle.mjs (shared with
// scripts/run-test-cycles.mjs). When TEST_RESULTS_PATH is set, the cycles
// already ran in the isolated test-cycles job and this process only
// applies their recorded results; a tool with no result for its current
// version is deferred to a later cycle rather than executed here, in the
// job that holds the write token.
const testResultsPath = (process.env.TEST_RESULTS_PATH ?? "").trim();
let testResults = null;
if (testResultsPath) {
  try { testResults = loadJson(testResultsPath); }
  catch { console.log(`test results artifact unreadable at ${testResultsPath}; deferring all test cycles`); testResults = {}; }
}

for (const [tool, t] of Object.entries(status.tools ?? {})) {
  const prev = t.tests && typeof t.tests === "object" ? t.tests : null;
  const prevTested = prev?.tested_version ?? null;
  if (!t.version || prevTested === t.version) continue;
  console.log(`test cycle: ${tool} v${t.version} (recorded counts were from ${prevTested ?? "no recorded version"})`);
  let res;
  if (testResults) {
    res = testResults[tool] ?? null;
    if (!res || res.tested_version !== t.version) {
      console.log(`test cycle: ${tool} v${t.version} has no isolated result for this version; deferring to a later cycle`);
      continue;
    }
    console.log(`test cycle: ${tool} v${t.version} applying isolated result ${res.state}`);
  } else {
    res = runTestCycle(tool, t.version);
  }
  t.tests = res;
  changed = true;
  saveJson(STATUS_PATH, status);
  console.log(`test cycle: ${tool} v${t.version} -> ${res.state}${res.total != null ? ` (${res.passed}/${res.total} passed)` : ""} in ${res.duration_s}s`);
  if (res.state === "fail") {
    addEvent({
      id: `tests-${tool}-${t.version}-fail`, ts: stamp, type: "finding_detected", severity: "high",
      scope: "own", tool, repo: `CloudCorpRecords/${tool}`,
      title: `${tool} v${t.version}: ${res.failed} of ${res.total} tests failing in the board's own re-run`,
      detail: `The board pipeline cloned the v${t.version} release tag, ran npm ci and the tool's own test suite, and ${res.failed} tests failed. Test counts on this board are produced by that re-run, so a red suite shows here as a danger, never as stale green.`,
    });
  } else if (res.state === "error") {
    addEvent({
      id: `tests-${tool}-${t.version}-error`, ts: stamp, type: "finding_detected", severity: "medium",
      scope: "own", tool, repo: `CloudCorpRecords/${tool}`,
      title: `${tool} v${t.version}: test cycle could not complete (${res.error ?? "unknown error"})`,
      detail: `The board pipeline tried to re-run the v${t.version} test suite from the release tag and could not complete it. The tool card shows the error state until a later cycle succeeds; the previous counts are not presented as current.`,
    });
  } else if (prev && (prev.state === "fail" || prev.state === "error")) {
    addEvent({
      id: `tests-${tool}-${t.version}-green`, ts: stamp, type: "finding_resolved", severity: "resolved",
      scope: "own", tool, repo: `CloudCorpRecords/${tool}`,
      title: `${tool} v${t.version}: test suite green again in the board re-run (${res.passed} of ${res.total})`,
      detail: `The board pipeline re-ran the v${t.version} suite from the release tag: ${res.passed} passed, ${res.failed} failed, in ${res.duration_s}s.`,
    });
  }
}

// 6. merge, cap, archive, write on change only.
if (newEvents.length) {
  eventsDoc.events = [...newEvents, ...events].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  if (eventsDoc.events.length > MAX_EVENTS) {
    const overflow = eventsDoc.events.splice(MAX_EVENTS);
    const byMonth = {};
    for (const ev of overflow) (byMonth[ev.ts.slice(0, 7)] ??= []).push(ev);
    const archDir = join(DATA, "archive");
    mkdirSync(archDir, { recursive: true });
    for (const [month, evs] of Object.entries(byMonth)) {
      const p = join(archDir, `events-${month}.json`);
      const existing = existsSync(p) ? loadJson(p) : [];
      saveJson(p, [...existing, ...evs]);
      console.log(`archived ${evs.length} events to ${p}`);
    }
  }
  eventsDoc.generated_at = stamp;
}
if (changed) {
  status.generated_at = stamp;
  status.pipeline = { ...(status.pipeline ?? {}), last_scan_at: stamp, interval_minutes: 15 };
  saveJson(STATUS_PATH, status);
  saveJson(EVENTS_PATH, eventsDoc);
  console.log(`data updated at ${stamp}: ${newEvents.length} new events`);
} else {
  console.log("no changes; data files untouched");
}
