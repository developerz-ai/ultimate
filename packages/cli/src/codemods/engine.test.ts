// The engine: which codemods a hop runs (since in (from, to], version then id), that a dry run
// writes nothing yet reports what a run would, that each sees the last one's output, and that one
// which throws loses its own writes and nothing else.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { Codemod } from './codemod';
import { memoryCodemodApp } from './codemod';
import { pendingCodemods, runCodemods } from './engine';

/** A codemod appending its id to `log.txt`, so the order they ran in is the file. */
const appender = (id: string, since: string): Codemod => ({
  id,
  since,
  summary: `appends ${id}`,
  async run(app) {
    await app.write('log.txt', `${(await app.read('log.txt')) ?? ''}${id}\n`);
    return { changed: ['log.txt'], skipped: [] };
  },
});

const ALL: readonly Codemod[] = [
  appender('b-late', '31.22.0'),
  appender('z-first', '31.20.0'),
  appender('a-late', '31.22.0'),
  appender('too-old', '31.4.0'),
  appender('too-new', '32.0.0'),
  appender('at-from', '31.15.0'),
  appender('at-to', '31.28.0'),
];

describe('unit · codemod engine', () => {
  test('a hop runs the codemods since in (from, to], by version and then by id', () => {
    const ids = pendingCodemods(ALL, '31.15.0', '31.28.0').map((codemod) => codemod.id);
    expect(ids).toEqual(['z-first', 'a-late', 'b-late', 'at-to']);
  });

  test('versions compare numerically, never as text', () => {
    const ids = pendingCodemods(
      [appender('nine', '31.9.0'), appender('ten', '31.10.0')],
      '31.8.0',
      '31.10.0',
    ).map((codemod) => codemod.id);
    expect(ids).toEqual(['nine', 'ten']);
  });

  test('each codemod sees what the one before it wrote, and the run writes it', async () => {
    const app = memoryCodemodApp({});
    const report = await runCodemods({
      app,
      codemods: ALL,
      from: '31.15.0',
      to: '31.28.0',
      dryRun: false,
    });
    expect(app.files['log.txt']).toBe('z-first\na-late\nb-late\nat-to\n');
    expect(report.applied.map((one) => one.id)).toEqual(['z-first', 'a-late', 'b-late', 'at-to']);
    expect(report.applied[0]).toEqual({
      id: 'z-first',
      since: '31.20.0',
      summary: 'appends z-first',
      changed: ['log.txt'],
      skipped: [],
    });
  });

  test('a dry run writes nothing and reports the same changes a run would make', async () => {
    const app = memoryCodemodApp({ 'log.txt': 'before\n' });
    const report = await runCodemods({
      app,
      codemods: ALL,
      from: '31.15.0',
      to: '31.28.0',
      dryRun: true,
    });
    expect(app.files).toEqual({ 'log.txt': 'before\n' });
    expect(report.dryRun).toBe(true);
    expect(report.applied.flatMap((one) => one.changed)).toEqual([
      'log.txt',
      'log.txt',
      'log.txt',
      'log.txt',
    ]);
  });

  test('changed is what the codemod actually changed: rewriting the same bytes is no change', async () => {
    const same: Codemod = {
      id: 'same',
      since: '31.20.0',
      summary: 'rewrites a file as it is',
      async run(app) {
        await app.write('a.ts', (await app.read('a.ts')) ?? '');
        return { changed: ['a.ts'], skipped: [] };
      },
    };
    const report = await runCodemods({
      app: memoryCodemodApp({ 'a.ts': 'x\n' }),
      codemods: [same],
      from: '31.0.0',
      to: '31.20.0',
      dryRun: false,
    });
    expect(report.applied[0]?.changed).toEqual([]);
  });

  test('a removal is a change, and a later glob no longer sees the file', async () => {
    const remove: Codemod = {
      id: 'remove',
      since: '31.20.0',
      summary: 'removes the old hook',
      async run(app) {
        await app.remove('old.sh');
        return { changed: ['old.sh'], skipped: [] };
      },
    };
    const look: Codemod = {
      id: 'look',
      since: '31.21.0',
      summary: 'lists what is left',
      async run(app) {
        await app.write('seen.txt', (await app.glob('*.sh')).join(','));
        return { changed: [], skipped: [] };
      },
    };
    const app = memoryCodemodApp({ 'old.sh': 'x', 'keep.sh': 'y' });
    const report = await runCodemods({
      app,
      codemods: [remove, look],
      from: '31.0.0',
      to: '31.21.0',
      dryRun: true,
    });
    expect(report.applied[0]?.changed).toEqual(['old.sh']);
    expect(report.applied[1]?.changed).toEqual(['seen.txt']);
    // Read back through the dry run's own view: `look` saw the removal it had not been written.
    expect(app.files).toEqual({ 'old.sh': 'x', 'keep.sh': 'y' });
  });

  test('a skipped file is reported with its reason and diff, as the codemod gave them', async () => {
    const skip: Codemod = {
      id: 'skip',
      since: '31.20.0',
      summary: 'meets an edited file',
      async run() {
        return {
          changed: [],
          skipped: [{ path: 'a.ts', reason: 'the app edited it', diff: '--- a/a.ts\n' }],
        };
      },
    };
    const report = await runCodemods({
      app: memoryCodemodApp({}),
      codemods: [skip],
      from: '31.0.0',
      to: '31.20.0',
      dryRun: false,
    });
    expect(report.applied[0]?.skipped).toEqual([
      { path: 'a.ts', reason: 'the app edited it', diff: '--- a/a.ts\n' },
    ]);
  });

  test('a codemod that throws loses its own writes, is reported, and the next one still runs', async () => {
    const broken: Codemod = {
      id: 'broken',
      since: '31.20.0',
      summary: 'throws halfway',
      async run(app) {
        await app.write('half.txt', 'half');
        throw new UltimateError({ code: 'X_PLANTED_FAILURE', cause: 'boom', fix: 'x verify' });
      },
    };
    const app = memoryCodemodApp({});
    const report = await runCodemods({
      app,
      codemods: [broken, appender('after', '31.21.0')],
      from: '31.0.0',
      to: '31.21.0',
      dryRun: false,
    });
    expect(app.files).toEqual({ 'log.txt': 'after\n' });
    expect(report.applied[0]?.changed).toEqual([]);
    expect(report.applied[0]?.skipped[0]?.path).toBe('.');
    expect(report.applied[0]?.skipped[0]?.reason).toContain('boom');
    expect(report.applied[1]?.changed).toEqual(['log.txt']);
  });
});
