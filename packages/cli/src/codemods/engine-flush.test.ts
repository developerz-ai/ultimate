// The flush that lands a run: writes before removals, so an interrupted run never leaves a tree
// whose evidence is gone and whose replacement is not there (vendored guards removed, no
// `guards/shipped.json`, which a rerun reads as a legacy app and writes `"warning"` everywhere);
// and a file whose bytes moved since the run read it is never overwritten.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { SHIPPED_GUARD_CONFIG } from '../guards-built-in';
import {
  SHIPPED_GUARD_NAMES,
  shippedGuardSource,
  shippedGuardTest,
} from '../templates/scaffold-guards';
import type { Codemod, CodemodApp } from './codemod';
import { memoryCodemodApp } from './codemod';
import { runCodemods } from './engine';
import { codemod as vendoredGuards } from './vendored-guards';

const vendoredTree = (): Record<string, string> =>
  Object.fromEntries(
    SHIPPED_GUARD_NAMES.flatMap((name) => [
      [`guards/${name}.ts`, shippedGuardSource(name) ?? ''],
      [`guards/${name}.test.ts`, shippedGuardTest(name) ?? ''],
    ]),
  );

/** The app, with a write of `failing` that dies once — the disk filling up, a killed process. */
const failingOnce = (files: Record<string, string>, failing: string): CodemodApp => {
  const app = memoryCodemodApp(files);
  let armed = true;
  return {
    ...app,
    write: async (path, source) => {
      if (path === failing && armed) {
        armed = false;
        throw new UltimateError({
          code: 'X_PLANTED_FAILURE',
          cause: 'ENOSPC: no space left on device',
          fix: 'x verify',
        });
      }
      await app.write(path, source);
    },
  };
};

const run = (app: CodemodApp) =>
  runCodemods({ app, codemods: [vendoredGuards], from: '31.27.0', to: '31.28.0', dryRun: false });

describe('unit · codemod engine, the flush', () => {
  test('a failed shipped.json write, then a rerun: no gating guard is weakened to "warning"', async () => {
    const files = vendoredTree();
    await expect(run(failingOnce(files, SHIPPED_GUARD_CONFIG))).rejects.toMatchObject({
      code: 'X_PLANTED_FAILURE',
    });
    // Writes land before removals: the copies are all still there for the rerun to read.
    expect(
      Object.keys(files).filter((path) => path.startsWith('guards/') && path.endsWith('.ts'))
        .length,
    ).toBe(SHIPPED_GUARD_NAMES.length * 2);
    await run(memoryCodemodApp(files));
    expect(files[SHIPPED_GUARD_CONFIG] ?? '').not.toContain('"warning"');
    // And the removals do land once the writes have: the copies are gone after the rerun.
    expect(Object.keys(files).filter((path) => path.endsWith('.ts'))).toEqual([]);
  });

  test('a file whose bytes moved after the run read it is never overwritten, and nothing lands', async () => {
    const files: Record<string, string> = { 'a.txt': 'old\n', 'b.txt': 'b\n' };
    const app = memoryCodemodApp(files);
    const racer: Codemod = {
      id: 'racer',
      since: '31.28.0',
      summary: 'rewrites a.txt and b.txt; someone else edits a.txt meanwhile',
      async run(staged) {
        await staged.write('b.txt', `${(await staged.read('b.txt')) ?? ''}more\n`);
        await staged.write('a.txt', `${(await staged.read('a.txt')) ?? ''}new\n`);
        files['a.txt'] = 'the author typed this\n';
        return { changed: ['a.txt', 'b.txt'], skipped: [] };
      },
    };
    const report = await runCodemods({
      app,
      codemods: [racer],
      from: '31.27.0',
      to: '31.28.0',
      dryRun: false,
    });
    expect(files).toEqual({ 'a.txt': 'the author typed this\n', 'b.txt': 'b\n' });
    expect(report.applied[0]?.changed).toEqual([]);
    expect(report.applied[0]?.skipped.map((skip) => skip.path)).toEqual(['a.txt']);
  });
});
