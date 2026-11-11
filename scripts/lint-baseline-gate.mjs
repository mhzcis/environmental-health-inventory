#!/usr/bin/env node
// R8-LINT-01: fail on any TypeScript diagnostic (`npm run lint` = tsc --noEmit with noUnused*) that is not in the
// reviewed baseline. The baseline may only shrink; `lint` itself is not relaxed and still reports every entry.
// Usage: node scripts/lint-baseline-gate.mjs [--write]   (--write only after a reviewed cleanup)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const BASELINE = 'qa/lint-baseline.txt';
export const normalize = (output) => {
  const out = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/);
    if (match) out.push(`${match[1]} ${match[2]} ${match[3]}`);
  }
  return out.sort();
};
export const compare = (baseline, current) => {
  const remaining = new Map();
  for (const entry of baseline) remaining.set(entry, (remaining.get(entry) || 0) + 1);
  const added = [];
  for (const entry of current) {
    const count = remaining.get(entry) || 0;
    if (count > 0) remaining.set(entry, count - 1); else added.push(entry);
  }
  const fixed = [...remaining.entries()].flatMap(([entry, count]) => Array(count).fill(entry));
  return { added, fixed };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = spawnSync('npx', ['tsc', '--noEmit'], { encoding: 'utf8' });
  if (run.error) { console.error(run.error.message); process.exit(2); }
  const current = normalize(`${run.stdout}\n${run.stderr}`);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(BASELINE, `${current.join('\n')}\n`);
    console.log(`baseline written: ${current.length} diagnostics`);
    process.exit(0);
  }
  const baseline = fs.readFileSync(BASELINE, 'utf8').split('\n').filter(Boolean);
  const { added, fixed } = compare(baseline, current);
  console.log(JSON.stringify({ baseline: baseline.length, current: current.length, added: added.length, fixed: fixed.length }, null, 1));
  if (fixed.length) console.log(`fixed (please shrink the baseline with --write after review):\n${fixed.join('\n')}`);
  if (added.length) { console.error(`NEW diagnostics not in the reviewed baseline:\n${added.join('\n')}`); process.exit(1); }
}
