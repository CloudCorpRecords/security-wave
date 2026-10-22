# How this board updates itself

The Live Danger Board has no hand-exported numbers. Every figure on the
page is produced by the pipeline in this repo from a source it can point
at, on a 15 minute cadence. This file is the map: what updates, from
where, and the one human step that remains.

## The loop

`.github/workflows/scan.yml` runs `scripts/update-data.mjs` every 15
minutes (and on manual dispatch). Each run:

1. **Records.** Parses the two committed records in `ledger/` (see
   below) and derives the ledger counters and program figures into
   `data/status.json`.
2. **Versions.** Reads npm latest for hookcheck, actionpin, injectcheck,
   and tracewatch. A version change appends a release event to
   `data/events.json`.
3. **Watchlist.** Re-scans the 13 factory repos in the watchlist with
   the published actionpin and hookcheck binaries; verdict changes, pin
   regressions, and RISKY finding deltas become feed events.
4. **Extra scan.** A dispatch may name one extra CloudCorpRecords repo
   to scan once; it is reported in the feed either way.
5. **Test cycles.** For each tool whose npm version differs from the
   version its recorded test counts were produced on: clone the tool
   repo at the release tag, `npm ci`, run the tool's own test suite,
   and record pass/fail/total, the tested version, and the run time.
   Counts are parsed from the suite's TAP summary. A suite that fails,
   or a cycle that cannot complete (clone, install, timeout, unparsable
   output), is recorded as a failed or errored state on the tool card
   and appended to the feed as a danger event. Stale green is never
   kept: the board would rather show an error than yesterday's pass.
6. **Commit.** If anything changed, the workflow commits `data/` as
   `data: scheduled scan update`. Test cycle results are also written
   to `data/status.json` as each cycle completes, so a job timeout
   cannot lose a finished cycle.

GitHub Pages serves the repo root; the page re-fetches its three data
files every 60 seconds.

## Where each number comes from

| Board figure | Source | Updated by |
| --- | --- | --- |
| Tool versions | npm registry | pipeline, step 2 |
| Test counts | the tool's own suite, run by the pipeline from the release tag | pipeline, step 5, on version change only |
| Dangers feed | pipeline scans and events, capped at 500, older archived by month under `data/archive/` | pipeline, steps 2 to 5 |
| Watchlist grid | actionpin and hookcheck scans of the factory repos | pipeline, step 3 |
| Ledger counters (found, fixed, open by severity, limits) | parsed from `ledger/problems.md` by `scripts/parse-records.mjs` | validation process commits the ledger; pipeline parses it every run |
| Corpus files and checks, coverage, round state | parsed from `ledger/program.md` | validation process commits the record; pipeline parses it every run |
| Proofs section | `data/proofs.json`, rendered exactly as committed | proof pack commits the finalized file (see below) |

Per-section freshness stamps on the page: the feed and grid carry the
last pipeline scan time; the ledger section carries the last commit
time of `ledger/problems.md` (the workflow checks out full history for
this); each tool card carries its tested version and test run time;
the proofs section carries the proof pack's own date.

Failure behavior: if a record file is missing or unparseable, the
pipeline keeps the last good values and marks them STALE on the board.
A section never goes blank because a record broke.

## The one remaining human step

Two commits in the whole system are made by the validation process
(not by people typing numbers into the board, and not by the pipeline):

1. When a problem closes, a round lands, or the corpus and coverage
   figures move, the validation process commits the updated
   `ledger/problems.md` and `ledger/program.md` to this repo.
2. When the Cloudflare head-to-head proof pack finalizes, it commits
   `data/proofs.json` with the finalized benchmark fields (latency,
   time to detect, detection, claim wording, honesty notes). The page
   renders those fields and leaves the in-progress state with no page
   edit; until that commit lands, the section honestly says the
   benchmark is in progress.

Everything downstream of those commits is automatic.

## Triggers

- **Schedule:** `*/15 * * * *` on `scan.yml`.
- **Manual:** `workflow_dispatch`, with the optional `extra_repo`
  input.
- **A future release-event trigger** (not wired): to make a tool
  release refresh the board within seconds instead of at the next
  quarter hour, each tool repo would need a release workflow step that
  calls this repo's `workflow_dispatch` API for `scan.yml`, which
  needs a fine-grained token scoped to this repo's Actions stored as
  a secret in each tool repo. The 15 minute poll already bounds the
  delay, so this is an optimization, not a correctness gap.

## The board audits itself

The workflow's own actions are pinned by full SHA. After any change
to this repo, the board's own tool gives the verdict:

```
npx -y @reneturcios/actionpin audit .
# PINNED
```
