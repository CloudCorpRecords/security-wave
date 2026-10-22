# Security Wave program record

Committed record for the board's program-level figures: the accumulated
regression corpus, validation coverage, and validation round state. These
numbers used to be a hand export typed into data/status.json; now they live
here as plain lines the board pipeline parses on every run
(scripts/parse-records.mjs). Updated by the validation process when a round
or a fix pass closes, in the same commit style as ledger/problems.md. If a
line is missing or unparseable, the pipeline keeps the last good values and
flags them stale on the board; it never blanks a section.

Format: one fact per line, "- Key: value". Keep the keys exactly as written;
the parser keys on them.

## Corpus

- Corpus files: 855
- Corpus checks: 255
- Corpus note: Accumulated regression corpus: every failure ever caught, re-run in full before any release counts. 223 of 223 checks PASS on the final binaries at Round 4; tranche 2 (mcpvet, depguard, flowcheck v0.1.0, shipped 2026-10-22) added 32 checks and 45 fixture files, 255 of 255 PASS on the final binaries at the tranche 2 close-out (files counted from the corpus tree at the same close-out).

## Coverage

- Coverage distinct repos: 176
- Coverage mutations: 3569
- Coverage real texts: 550
- Coverage note: Overnight totals: 176+ distinct real repos scanned, 3,569 verdict-stability mutations, 550 hand-labeled real issue and PR texts, 662 labeled dataset rows.

## Rounds

- Rounds latest: Round 4
- Rounds verdict: SOLID
- Rounds determinism: 10 of 10 target sets identical across 3 runs (Round 4, now including tracewatch)
- Rounds bar: Solid requires a validation round with zero BLOCKER and zero unexplained REAL problems on the final binaries.
- Rounds note: Round 4 (the fix pass 2 close-out) ran on the final binaries, hookcheck 0.1.16, actionpin 0.1.6, injectcheck 0.1.13, tracewatch 0.1.0: zero BLOCKER, zero unexplained REAL, zero FIXED-UNVERIFIED. Its headline tally over all 111 entries: FIXED-CONFIRMED 104, 1 closed as not reproduced (P-073), 6 documented limits. Source: validation/SUMMARY.md Round 4 headline and validation/round4/ROUND4-REPORT.md.
