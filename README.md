# Security Wave: Live Danger Board

Public status board for the Security Wave (hookcheck, actionpin, injectcheck,
tracewatch), served at https://cloudcorprecords.github.io/security-wave/

The page is a single static `index.html` with no build step, no trackers, and
no third-party assets. It renders three data files:

- `data/events.json`: the dangers feed. Seeded with the program's real
  history (validation rounds, releases with npm-registry timestamps, the
  factory pinning waves) and appended to by the scheduled scan.
- `data/status.json`: tool versions, the hand-verified problem-ledger
  counters, corpus size, and the factory watchlist grid.
- `data/proofs.json`: the Cloudflare head-to-head proof section. Until the
  proof pack's finalized files land it shows an honest benchmark-in-progress
  state plus the sourced research findings.

## The pipeline

`.github/workflows/scan.yml` runs every 15 minutes (and on manual dispatch).
It installs the four published tools from npm, watches npm for version
changes, re-scans the factory watchlist with actionpin and hookcheck, diffs
against the stored grid, appends events for verdict changes, pin regressions,
and finding deltas, and commits only when something changed. The workflow's
own actions are SHA-pinned, and the repo audits PINNED under its own tool.

`scripts/update-data.mjs` is the whole pipeline (Node >= 20, no dependencies).
A manual dispatch accepts an `extra_repo` input (CloudCorpRecords namespace
only) that is scanned once and reported in the feed either way.

Public accuracy rule, enforced by the pipeline's design: the scheduled scan
only ever scans our own repos, so it can name them. Anything external is
reported in aggregate only, and only from the hand-verified record.

## Freshness

Scans are live (15-minute cadence). Ledger counters are hand-exported from
the validation ledger in the program workspace and carry their export date
in `data/status.json`; they change when a validation round or fix pass
closes, not on the scan cadence. The page states this split openly.

Events are capped at the newest 500; overflow is archived by month under
`data/archive/`.
