// Security Wave Live Danger Board: record parsers.
//
// Pure, zero-dependency parsers for the two committed records the board
// derives its slow-moving numbers from:
//
//   ledger/problems.md  the public problem ledger of record. The validation
//                       process commits updates here as problems close; the
//                       pipeline re-parses it on every run, so the board's
//                       ledger counters are never a hand export again.
//   ledger/program.md   corpus size, validation coverage, round state.
//
// Contract: a parse either returns complete counters or throws. The caller
// (scripts/update-data.mjs) catches a throw and keeps the last good values,
// flagging them stale on the board. A section is never blanked by a bad
// record. See SELF-UPDATE.md for the full loop.

// ---------------------------------------------------------------- ledger --

// Problem headings look like:
//   ### P-001 REAL (actionpin) Piped --json output truncates ...
//   ### P-027 REAL, low (injectcheck) Zero-width joiner ...
//   ### P-009 LIMIT (hookcheck) Heuristic boundary ...
// A few flywheel entries carry their fix version in the severity slot
// ("### P-106 FIXED in v0.1.11 (hookcheck) ..."); those are real problems
// with no severity rank in the heading and are counted as unranked.
// Addendum headings ("### P-032 wild evidence addendum (from Wave B ...)") are
// not problems: their parenthetical is prose, not a tool token, so the tool
// group must be a single lowercase token (actionpin, hookcheck, factory...).
const HEADING_RE = /^### (P-\d+)\s+(.+?)\s*\(([^)]+)\)\s*(.*)$/;
// One tool token, or a comma list of them ("actionpin, hookcheck", P-014).
const TOOL_TOKEN_RE = /^[a-z][a-z0-9-]*(\s*,\s*[a-z][a-z0-9-]*)*$/;

function severityOf(slot) {
  const s = slot.trim();
  if (/^BLOCKER\b/.test(s)) return { key: "blocker", sev: "BLOCKER", low: false };
  if (/^REAL\b/.test(s)) {
    const low = /,?\s*low\b/i.test(s.slice(4));
    return { key: low ? "real_low" : "real", sev: "REAL", low };
  }
  if (/^COSMETIC\b/.test(s)) return { key: "cosmetic", sev: "COSMETIC", low: false };
  if (/^LIMIT\b/.test(s)) return { key: "limit", sev: "LIMIT", low: false };
  return null;
}

function dispositionOf(statusLine) {
  const s = statusLine.trim();
  if (/^NOT REPRODUCED/i.test(s)) return "closed_no_repro";
  if (/^FIXED/i.test(s)) return "fixed";
  if (/^LIMIT/i.test(s)) return "limit";
  if (/^OPEN/i.test(s)) return "open";
  return "unknown";
}

export function parseLedger(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  let cur = null;
  const flush = () => { if (cur) entries.push(cur); cur = null; };
  for (const line of lines) {
    const h = line.match(HEADING_RE);
    if (h && TOOL_TOKEN_RE.test(h[3].trim())) {
      flush();
      const sev = severityOf(h[2]);
      cur = {
        id: h[1], severity: sev ? sev.sev : "UNRANKED", sevKey: sev ? sev.key : "unranked",
        low: sev ? sev.low : false,
        tool: h[3], title: (h[4] || "").trim(),
        status: null,
      };
      continue;
    }
    if (/^### /.test(line)) { flush(); continue; }
    if (/^## /.test(line)) { flush(); continue; }
    if (!cur) continue;
    if (cur.status === null) {
      const sm = line.match(/^-\s+Status:\s*(.+)$/);
      if (sm) cur.status = sm[1];
    }
  }
  flush();

  if (entries.length === 0) throw new Error("ledger parse: no problem entries found");

  const out = {
    found: entries.length,
    fixed: 0, limits: 0, closed_no_repro: 0,
    open_total: 0, unknown_disposition: 0,
    open_blocker: 0, open_real: 0, open_real_low: 0, open_cosmetic: 0,
    by_severity: { blocker: 0, real: 0, real_low: 0, cosmetic: 0, limit: 0, unranked: 0 },
    open_entries: [],
    missing_status: [],
    rounds: parseRoundVerdicts(lines),
  };

  for (const e of entries) {
    out.by_severity[e.sevKey] += 1;
    if (e.status === null) { out.missing_status.push(e.id); out.unknown_disposition += 1; continue; }
    const d = dispositionOf(e.status);
    if (d === "fixed") out.fixed += 1;
    else if (d === "limit") out.limits += 1;
    else if (d === "closed_no_repro") out.closed_no_repro += 1;
    else if (d === "open") {
      out.open_total += 1;
      out.open_entries.push({ id: e.id, severity: e.sev + (e.low ? " low" : ""), title: e.title });
      if (e.sevKey === "blocker") out.open_blocker += 1;
      else if (e.sevKey === "real") out.open_real += 1;
      else if (e.sevKey === "real_low") out.open_real_low += 1;
      else if (e.sevKey === "cosmetic") out.open_cosmetic += 1;
    } else out.unknown_disposition += 1;
  }
  out.open_detail = buildOpenDetail(out);
  return out;
}

function buildOpenDetail(o) {
  if (o.open_total === 0 && o.unknown_disposition === 0) {
    return `Nothing is open. All ${o.found} ledgered problems are closed: ${o.fixed} fixed, ` +
      `${o.limits} documented limits, ${o.closed_no_repro} closed as not reproduced. ` +
      `The open bar now is the round verdict: solid still requires a full validation round ` +
      `with zero BLOCKER and zero unexplained REAL on the final binaries.`;
  }
  const byKey = { BLOCKER: [], REAL: [], "REAL low": [], COSMETIC: [] };
  for (const e of o.open_entries) (byKey[e.severity] ??= []).push(`${e.id} (${e.title})`);
  const parts = [];
  for (const [k, v] of Object.entries(byKey)) {
    if (v.length) parts.push(`Open ${k}: ${v.join("; ")}.`);
  }
  if (o.unknown_disposition) parts.push(`${o.unknown_disposition} entr${o.unknown_disposition === 1 ? "y has" : "ies have"} an unrecognized status line and need a ledger review.`);
  return parts.join(" ");
}

// Round verdict tables: sections headed "## ... verdicts ..." carry a
// markdown table of per-problem outcomes recorded at the time. Parsed
// generically so a future round's table lands on the board with no code
// change. Rows are counted, never re-derived: a round table is a snapshot
// of what that round found, and later rounds supersede it in the entries.
function parseRoundVerdicts(lines) {
  const rounds = [];
  let current = null;
  for (const line of lines) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      if (current) rounds.push(current);
      current = /verdict/i.test(h[1])
        ? { round: h[1].trim(), confirmed_fixed: 0, still_open: 0, limit: 0, rows: 0 }
        : null;
      continue;
    }
    if (!current) continue;
    if (!/^\|/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim());
    const idCell = cells.find((c) => /\bP-\d+\b/.test(c));
    if (!idCell) continue;
    const outcome = cells.join(" ");
    current.rows += 1;
    if (/CONFIRMED FIXED/i.test(outcome)) current.confirmed_fixed += 1;
    else if (/STILL OPEN/i.test(outcome)) current.still_open += 1;
    else if (/\bLIMIT\b/i.test(outcome)) current.limit += 1;
  }
  if (current) rounds.push(current);
  return rounds.filter((r) => r.rows > 0);
}

// --------------------------------------------------------------- program --

// ledger/program.md carries one fact per line: "- Key: value".
export function parseProgram(text) {
  const kv = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^-\s+([^:]+):\s*(.+)$/);
    if (m) kv[m[1].trim()] = m[2].trim();
  }
  const num = (k) => {
    const v = kv[k];
    if (v == null) return null;
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const out = {
    corpus: {
      files: num("Corpus files"),
      checks: num("Corpus checks"),
      note: kv["Corpus note"] ?? null,
    },
    coverage: {
      distinct_repos: num("Coverage distinct repos"),
      mutations: num("Coverage mutations"),
      real_texts: num("Coverage real texts"),
      note: kv["Coverage note"] ?? null,
    },
    rounds: {
      latest: kv["Rounds latest"] ?? null,
      verdict: kv["Rounds verdict"] ?? null,
      determinism: kv["Rounds determinism"] ?? null,
      bar: kv["Rounds bar"] ?? null,
      note: kv["Rounds note"] ?? null,
    },
  };
  const required = [
    out.corpus.files, out.corpus.checks,
    out.coverage.distinct_repos, out.coverage.mutations, out.coverage.real_texts,
    out.rounds.latest, out.rounds.verdict,
  ];
  if (required.some((v) => v == null)) {
    throw new Error("program record parse: a required line is missing or unparseable");
  }
  return out;
}
