// The framework's own DatabaseCleaner + tmp:clear (#738): what a test run leaves behind is the
// framework's to sweep, so an app never accumulates it. The test runner tidies before every run
// (`mode: 'auto'`: the newest two of each cache stay); `x clean` clears it all (`mode: 'all'`).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no utimes, no existence check for a directory and no recursive remove.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { PgExecutor } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import { type HousekeepingReport, tidyBeforeTestRun, tidyTestState } from './test-housekeeping';

const scratch = mkdtempSync(join(tmpdir(), 'x-housekeeping-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** What a sweep's dependency throws: a server down, a disk refusing — coded, as the framework's are. */
const unreachableServer = (): UltimateError =>
  new UltimateError({
    code: 'X_DB_UNAVAILABLE',
    cause: 'connection refused',
    fix: 'start the test Postgres',
  });

const MIN = 60_000;
function touch(path: string, ageMs = 0): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(path, at, at);
}

/** An app with four templates, three PGlite snapshots, a sass entry, and the #738 debris. */
function app(name: string): string {
  const root = join(scratch, name);
  touch(join(root, 'app.config.ts'));
  for (const [index, key] of [
    'aaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbb',
    'cccccccccccccccc',
    'dddddddddddddddd',
  ].entries()) {
    touch(join(root, '.x', 'test-db', `pglite-${key}.tar`), index * MIN);
  }
  for (const [index, version] of ['0.3.0-f1', '0.2.0-f1', '0.1.0-f1'].entries()) {
    touch(join(root, '.x', 'cache', `pglite-${version}.snapshot`), index * MIN);
  }
  touch(join(root, '.x', 'cache', 'sass', 'entry.json'));
  touch(join(root, '.x', 'pgdata', 'PG_VERSION'));
  // The debris: `.x/cache` written beside the code by a process started in a source folder.
  touch(join(root, 'apps', 'web', 'app', 'casos', '.x', 'cache', 'sass', 'entry.json'));
  // A nested APP owns its own `.x`; a dependency's is not ours to touch.
  touch(join(root, 'examples', 'inner', 'app.config.ts'));
  touch(join(root, 'examples', 'inner', '.x', 'cache', 'keep.json'));
  touch(join(root, 'node_modules', 'pkg', '.x', 'cache', 'keep.json'));
  return root;
}

const names = (dir: string): readonly string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe('tidyTestState', () => {
  test("'auto' keeps the newest two templates and snapshots and removes the debris", async () => {
    const root = app('auto');
    await tidyTestState({ root, mode: 'auto', env: {} });
    expect(names(join(root, '.x', 'test-db'))).toEqual([
      'pglite-aaaaaaaaaaaaaaaa.tar',
      'pglite-bbbbbbbbbbbbbbbb.tar',
    ]);
    expect(names(join(root, '.x', 'cache'))).toEqual([
      'pglite-0.2.0-f1.snapshot',
      'pglite-0.3.0-f1.snapshot',
      'sass',
    ]);
    expect(existsSync(join(root, 'apps', 'web', 'app', 'casos', '.x'))).toBe(false);
    expect(existsSync(join(root, 'examples', 'inner', '.x', 'cache', 'keep.json'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', 'pkg', '.x', 'cache', 'keep.json'))).toBe(true);
    expect(existsSync(join(root, '.x', 'pgdata', 'PG_VERSION'))).toBe(true);
  });

  test("'all' clears the templates and the whole cache, never the dev database or storage", async () => {
    const root = app('all');
    const report = await tidyTestState({ root, mode: 'all', env: {} });
    expect(names(join(root, '.x', 'test-db'))).toEqual([]);
    expect(existsSync(join(root, '.x', 'cache'))).toBe(false);
    expect(existsSync(join(root, '.x', 'pgdata', 'PG_VERSION'))).toBe(true);
    expect(report.paths).toContain(join(root, '.x', 'cache'));
    expect(report.paths).toContain(join(root, 'apps', 'web', 'app', 'casos', '.x'));
  });

  test('`dryRun` reports the same paths and removes nothing', async () => {
    const root = app('dry');
    const report = await tidyTestState({ root, mode: 'all', env: {}, dryRun: true });
    expect(report.paths.length).toBeGreaterThan(0);
    expect(names(join(root, '.x', 'test-db'))).toHaveLength(4);
    expect(existsSync(join(root, 'apps', 'web', 'app', 'casos', '.x'))).toBe(true);
  });

  test('outside an app (a package’s own folder) it sweeps no stray .x at all', async () => {
    const root = join(scratch, 'not-an-app');
    touch(join(root, 'src', '.x', 'cache', 'entry.json'));
    await tidyTestState({ root, mode: 'auto', env: {} });
    expect(existsSync(join(root, 'src', '.x', 'cache', 'entry.json'))).toBe(true);
  });

  test('with TEST_DATABASE_URL, the stale probe databases go too; without it no connection is made', async () => {
    const root = app('probes');
    const sent: string[] = [];
    const server: PgExecutor = {
      query: async <R>(text: string): Promise<readonly R[]> => {
        sent.push(text);
        return (text.startsWith('select')
          ? [{ datname: 'x_gone_1_tro8do_aaaaaaaa', backends: 0 }]
          : []) as unknown as readonly R[];
      },
    };
    let opened = 0;
    const connect = async () => {
      opened += 1;
      return { executor: server, close: async () => undefined };
    };
    const without = await tidyTestState({ root, mode: 'auto', env: {}, connect });
    expect(opened).toBe(0);
    expect(without.databases).toEqual([]);
    const report = await tidyTestState({
      root,
      mode: 'auto',
      env: { TEST_DATABASE_URL: 'postgres://localhost/postgres' },
      connect,
      isAlive: () => false,
      now: () => 1_800_000_000_000,
    });
    expect(opened).toBe(1);
    expect(report.databases).toEqual(['x_gone_1_tro8do_aaaaaaaa']);
    expect(sent.some((text) => text.startsWith('drop database'))).toBe(true);
  });

  test('a server that cannot be reached costs the sweep nothing but its databases', async () => {
    const root = app('unreachable');
    const report = await tidyTestState({
      root,
      mode: 'auto',
      env: { TEST_DATABASE_URL: 'postgres://localhost:1/postgres' },
      connect: async () => {
        throw unreachableServer();
      },
    });
    expect(report.databases).toEqual([]);
    expect(names(join(root, '.x', 'test-db'))).toHaveLength(2);
  });
});

describe('tidyBeforeTestRun', () => {
  test('sweeps once per app per process, whatever number of steps run tests', async () => {
    const root = app('once');
    let calls = 0;
    const tidy = async (): Promise<HousekeepingReport> => {
      calls += 1;
      return { paths: [], databases: [] };
    };
    await tidyBeforeTestRun(root, {}, tidy);
    await tidyBeforeTestRun(join(root, 'apps'), {}, tidy);
    expect(calls).toBe(1);
  });

  test('a sweep that throws never fails the run it precedes', async () => {
    const root = app('throws');
    await tidyBeforeTestRun(root, {}, async () => {
      throw unreachableServer();
    });
  });

  test('the real sweep, auto mode: the newest two templates stay', async () => {
    const root = app('real');
    await tidyBeforeTestRun(root, {});
    expect(names(join(root, '.x', 'test-db'))).toHaveLength(2);
  });
});
