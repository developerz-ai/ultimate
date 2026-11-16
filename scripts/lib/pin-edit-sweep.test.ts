// Every row of every real `scripts/lib/*-pins.ts` table, raised by one on a scratch copy and read
// back: exactly that row moves, by exactly one, with one placeholder line — no row shape in the
// tree mis-lands a `--write-pin` draft (a one-line row once raised the multi-line row after it).

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
import { applyPinRaise, PIN_WHY_MARK, pinRaiseOf } from './pin-edit';
import { importPinSource, pinRows } from './pin-rows';
import { PIN_GLOB } from './pin-tables';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();
const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A table `--write-pin` can edit: a `Record` literal of counts or `{ count }` rows. */
const RECORD = /^export const (\w+): Readonly<Record<string, [\w<>, ]+>> = \{/gm;

describe('--write-pin over every real pins table', () => {
  test('each row raised alone moves only itself, by one, under one placeholder', async () => {
    const scratch = await mkdtemp(`${tmpdir()}/pin-edit-sweep-`);
    made.push(scratch);
    let raised = 0;
    const wrong: string[] = [];
    for (const path of [...new Bun.Glob(PIN_GLOB).scanSync({ cwd: ROOT })].sort()) {
      const file = path.replaceAll('\\', '/');
      const absolute = `${ROOT}/${file}`;
      const source = await Bun.file(absolute).text();
      const before = pinRows(await importPinSource(source, scratch, absolute));
      for (const match of source.matchAll(RECORD)) {
        const table = match[1] ?? '';
        for (const [row, count] of before) {
          if (!row.startsWith(`${table}.`)) continue;
          const key = row.slice(table.length + 1);
          const raise = pinRaiseOf(
            { script: 'scripts/x.ts', file, table },
            { pkg: key, found: count + 1, pinned: count },
          );
          const text = applyPinRaise(source, raise);
          const after = pinRows(await importPinSource(text, scratch, absolute));
          const moved = [...after].filter(([name, value]) => before.get(name) !== value);
          const marks = text.split(PIN_WHY_MARK).length - 1;
          const ok =
            moved.length === 1 &&
            moved[0]?.[0] === row &&
            moved[0]?.[1] === count + 1 &&
            marks === 1;
          if (!ok) wrong.push(`${file} ${row}: moved ${JSON.stringify(moved)}, ${marks} mark(s)`);
          raised += 1;
        }
      }
    }
    // Non-vacuity: the tree's tables hold hundreds of rows in both shapes.
    expect(raised).toBeGreaterThan(100);
    expect(wrong).toEqual([]);
  });
});
