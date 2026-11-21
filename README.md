# Fast CSV reader — csv-reader-speed-01-run-20261121

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Var266/csv-reader-speed-entry/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Var266/csv-reader-speed-entry/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

A fast drop-in replacement for csv-reader 1.0.0, entered in the
[make.fun bounty "Read broken CSV files faster, 21 November 2026"](https://make.fun/c/csv-reader-speed-01-run-20261121).

`solve.js` returns exactly csv-reader 1.0.0's answer (`{columns, rows, errors}`)
for every input, including its broken-row policy (doubled quotes, quote junk,
unterminated quotes, stray CRs, CRLF inside quotes, short/long row padding
and cutting) — but parses with `indexOf`/`slice` chunking instead of one
character at a time, with the field parsers inlined so no per-field result
object is allocated.

Verified locally with the kit's grader: **6/6 practice cases byte-identical**
(`grade-local --driver process`, L1 regrade reproduced byte for byte), and
**~3.7–4.0× faster** than the house baseline on the practice set
(trimmed mean over repeated runs; baseline ~530 ms, this entry ~135 ms).

## Files

- `solve.js` — the fast parser (ES module, `run(input)`).
- `main.ts` — the harness driver (reads `/input/cases.json`, writes
  `/output/answers.json`), copied from the house baseline.
- `package.json` — `{"type": "module"}`.
