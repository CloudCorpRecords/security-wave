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
// Ledger counters in status.json are NOT touched here: they come from the
// hand-verified validation ledger and are refreshed by hand export only.
// The page states this freshness split openly.
//
// Files are rewritten only when something actually changed, so the workflow
// commits only on change. No dependencies beyond Node >= 20 and git.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");
const STATUS_PATH = join(DATA, "status.json");
const EVENTS_PATH = join(DATA, "events.json");
const MAX_EVENTS = 500;

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const saveJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 1) + "\n");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 120000, maxBuffer: 64 * 1024 * 1024 });
  return r;
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

// 4. merge, cap, archive, write on change only.
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
