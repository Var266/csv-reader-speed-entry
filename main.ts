// csv-reader 1.0.0 drop-in: the harness runs `node /bot/main.ts` (node22).
// It reads every case from /input/cases.json (a JSON array of {id, input}),
// answers each one alone, and writes /output/answers.json: a JSON array of
// the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The answers come from runCasesArray, which transduces the file's escaped
// text straight into each answer's JSON without parsing the file or building
// the nested answers (the contest scores total program CPU, and JSON.parse
// of the 11 MB file plus JSON.stringify of the 12 MB answers cost ~400 ms
// locally). The answers are written out piece by piece, not joined into one
// 12 MB string first: that join measured ~140 ms slower. Anything the
// transducer cannot handle falls back to the plain parser, so the entry
// stays correct, only slower.

import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
// TurboFan off as well: the transducer runs once per process, and TurboFan's
// repeated compile/deopt cycles on its big loop cost more than they save
// (measured: ~400 ms of a ~1 s cold run). Maglev alone compiles in
// milliseconds and stays stable.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbofan');
// A bigger young generation: the transducer allocates ~700k short-lived
// field slices, and the default small semi-spaces scavenge constantly
// (measured: ~150 ms of a cold run). The old-space cap keeps the heap from
// ballooning on the same allocation burst.
setFlagsFromString('--max-semi-space-size=64');
setFlagsFromString('--max-old-space-size=512');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run, runCasesArray } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  runCasesArray: (raw: string) => string[];
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
const outPath = join(OUTPUT_DIR, 'answers.json');
let answers: string[] | null = null;
try {
  answers = runCasesArray(raw);
} catch {
  // Malformed input for the transducer: the plain parser answers it instead.
  answers = null;
}
if (answers !== null) {
  const fd = openSync(outPath, 'w');
  try {
    writeSync(fd, '[');
    for (let i = 0; i < answers.length; i++) {
      if (i !== 0) writeSync(fd, ',');
      writeSync(fd, answers[i]);
    }
    writeSync(fd, ']');
  } finally {
    closeSync(fd);
  }
} else {
  const cases = JSON.parse(raw) as { id: string; input: unknown }[];
  const values: unknown[] = [];
  for (const c of cases) values.push(run(c.input));
  writeFileSync(outPath, JSON.stringify(values));
}
