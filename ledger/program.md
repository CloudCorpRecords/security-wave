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

- Corpus files: 810
- Corpus checks: 223
- Corpus note: Accumulated regression corpus: every failure ever caught, re-run in full before any release counts. 223 checks PASS, 0 FAIL on the published binaries at the fix pass 2 close-out (files counted from the corpus tree at the same close-out).

## Coverage

- Coverage distinct repos: 176
- Coverage mutations: 3569
- Coverage real texts: 550
- Coverage note: Overnight totals: 176+ distinct real repos scanned, 3,569 verdict-stability mutations, 550 hand-labeled real issue and PR texts, 662 labeled dataset rows.

## Rounds

- Rounds latest: Round 3
- Rounds verdict: NOT SOLID
- Rounds determinism: 10 of 10 target sets identical across 3 runs (Round 3)
- Rounds bar: Solid requires a validation round with zero BLOCKER and zero unexplained REAL problems on the final binaries.
- Rounds note: Round 4 mini-validation (the fix pass 2 close-out) is the next round; this record updates when it lands.
