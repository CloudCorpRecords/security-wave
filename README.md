# Security Wave: Live Danger Board

Public status board for the Security Wave (hookcheck, actionpin, injectcheck,
tracewatch), served at https://cloudcorprecords.github.io/security-wave/

The Security Wave is the security counterpart to [Greenlight](https://github.com/CloudCorpRecords/greenlight). Greenlight checks if an agent may contribute; the Security Wave checks if the repo an agent touches is trying to rob it. This repo is the wave's public status board and the record its pipeline maintains.

## The tools

- **[hookcheck](https://github.com/CloudCorpRecords/hookcheck)** (v0.1.16, [npm](https://www.npmjs.com/package/@reneturcios/hookcheck)): audits install hooks and agent autostart persistence in a repo (postinstall scripts, .claude hooks, .vscode tasks) for supply-chain backdoors
- **[actionpin](https://github.com/CloudCorpRecords/actionpin)** (v0.1.6, [npm](https://www.npmjs.com/package/@reneturcios/actionpin)): audits GitHub Actions for mutable refs and pins them to full SHAs, so a moved tag cannot change what your CI runs
- **[injectcheck](https://github.com/CloudCorpRecords/injectcheck)** (v0.1.13, [npm](https://www.npmjs.com/package/@reneturcios/injectcheck)): scans issues, PRs, docs and files an agent will read for prompt injection before the agent sees them
- **[tracewatch](https://github.com/CloudCorpRecords/tracewatch)** (v0.1.0, [npm](https://www.npmjs.com/package/@reneturcios/tracewatch)): tracks security scans over time, diffs findings, blames the commit that introduced each one, and watches repos with measured time-to-detect
- **[mcpvet](https://github.com/CloudCorpRecords/mcpvet)** (v0.1.0, [npm](https://www.npmjs.com/package/@reneturcios/mcpvet)): vets MCP servers and agent skills before you install them, auditing server and client configs, autostart entries, declared capabilities and bundled scripts for credential stealers, droppers and persistence shapes
- **[depguard](https://github.com/CloudCorpRecords/depguard)** (v0.1.0, [npm](https://www.npmjs.com/package/@reneturcios/depguard)): dependency early warning at PR time: diffs package.json and lockfiles and flags new dependencies, newly added install scripts and typosquat-shaped names before the change merges
- **[flowcheck](https://github.com/CloudCorpRecords/flowcheck)** (v0.1.0, [npm](https://www.npmjs.com/package/@reneturcios/flowcheck)): GitHub Actions least-privilege audit covering missing or write-all permissions, pull_request_target shapes, and secrets exposed to fork contexts

The page is a single static `index.html` with no build step, no trackers, and
no third-party assets. It renders three data files:

- `data/events.json`: the dangers feed. Seeded with the program's real
  history (validation rounds, releases with npm-registry timestamps, the
  factory pinning waves) and appended to by the scheduled scan.
- `data/status.json`: tool versions and test counts, the problem-ledger
  counters, corpus size, and the factory watchlist grid. Every block in
  this file is written by the pipeline from its source; none of it is
  typed in by hand (see SELF-UPDATE.md).
- `data/proofs.json`: the Cloudflare head-to-head proof section. Until the
  proof pack commits its finalized file it shows an honest
  benchmark-in-progress state plus the sourced research findings; when
  the finalized fields land, the section flips with no page edit.
- `ledger/problems.md`: the public problem ledger of record. The
  validation process commits updates here as problems close; the
  pipeline parses it on every run and derives the board's counters.
- `ledger/program.md`: the program record (corpus, coverage, rounds),
  same pattern: committed by the validation process, parsed every run.

## The pipeline

`.github/workflows/scan.yml` runs every 15 minutes (and on manual dispatch).
It installs the four published tools from npm, watches npm for version
changes, re-scans the factory watchlist with actionpin and hookcheck, diffs
against the stored grid, appends events for verdict changes, pin regressions,
and finding deltas, re-parses the committed records in `ledger/`, and, when a
tool's version has changed since its test counts were recorded, clones the
release tag and runs the tool's own test suite to produce fresh counts.
A failed suite is a feed event, never stale green. It commits only when
something changed. The workflow's own actions are SHA-pinned, and the repo
audits PINNED under its own tool.

`scripts/update-data.mjs` is the pipeline and `scripts/parse-records.mjs`
the record parsers (Node >= 20, no dependencies). A manual dispatch accepts
an `extra_repo` input (CloudCorpRecords namespace only) that is scanned
once and reported in the feed either way.

Public accuracy rule, enforced by the pipeline's design: the scheduled scan
only ever scans our own repos, so it can name them. Anything external is
reported in aggregate only, and only from the verified record.

## Freshness

Everything is live on the 15-minute cadence, and each section of the page
carries its own stamp: last scan for the feed and grid, the ledger file's
last commit time for the counters, the tested version and run time on each
tool card, the pack date on proofs. Nothing is hand-exported. The full
self-update loop, including the one human step that remains (the
validation process commits the ledger, program record, and proof pack
files as its work closes), is documented in SELF-UPDATE.md.

Events are capped at the newest 500; overflow is archived by month under
`data/archive/`.
