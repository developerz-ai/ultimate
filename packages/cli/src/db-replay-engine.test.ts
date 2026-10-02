// The engine rule, with the linker injected: the embedded database unless the migrations create
// an extension it cannot link, and — when they do and no server is named — a finding an author
// can act on. The server path itself runs in `db-replay-engine.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { Migration } from '@ultimat3/db';
import {
  chooseReplayEngine,
  type ExtensionLinker,
  REPLAY_URL_ENVS,
  replayServerMissing,
} from './db-replay-engine';
import { replayFailure } from './db-schema-refresh';
import { MIGRATIONS_DIR } from './migrations';

const migration = (up: string): Migration => ({ id: '0001', name: 'init', up, down: '' });

/** A linker that ships exactly `shipped`. */
const linking =
  (...shipped: readonly string[]): ExtensionLinker =>
  async (names) => ({
    linked: Object.fromEntries(names.filter((n) => shipped.includes(n)).map((n) => [n, n])),
    missing: names.filter((name) => !shipped.includes(name)),
  });

describe('chooseReplayEngine', () => {
  test('no extension: the embedded database, whatever URL is set', async () => {
    const engine = await chooseReplayEngine(
      [migration('create table t (id int);')],
      { TEST_DATABASE_URL: 'postgres://ci/postgres', DATABASE_URL: 'postgres://dev/app' },
      linking(),
    );
    // A set URL never moves the choice: a laptop with one and a CI without must agree.
    expect(engine).toEqual({ kind: 'embedded', extensions: [] });
  });

  test('every extension linkable: still the embedded database, with them named', async () => {
    const engine = await chooseReplayEngine(
      [migration('create extension citext; create extension "uuid-ossp";')],
      { DATABASE_URL: 'postgres://dev/app' },
      linking('citext', 'uuid-ossp'),
    );
    expect(engine).toEqual({ kind: 'embedded', extensions: ['citext', 'uuid-ossp'] });
  });

  test('one extension the embedded database cannot link: a real Postgres, by the harness’s own URL', async () => {
    const migrations = [migration('create extension citext; create extension postgis;')];
    expect(
      await chooseReplayEngine(
        migrations,
        { TEST_DATABASE_URL: 'postgres://ci/postgres', DATABASE_URL: 'postgres://dev/app' },
        linking('citext'),
      ),
    ).toEqual({ kind: 'postgres', adminUrl: 'postgres://ci/postgres', requires: ['postgis'] });
    // The same fallback order `@ultimat3/testing` reads its admin URL in; an empty value is unset.
    expect(
      await chooseReplayEngine(
        migrations,
        { TEST_DATABASE_URL: '', DATABASE_URL: 'postgres://dev/app' },
        linking('citext'),
      ),
    ).toMatchObject({ kind: 'postgres', adminUrl: 'postgres://dev/app' });
    expect(REPLAY_URL_ENVS).toEqual(['TEST_DATABASE_URL', 'DATABASE_URL']);
  });

  test('…and no server named: X_SCHEMA_DUMP_DRIFT naming the extension, the variable and the command', async () => {
    const refusal = await chooseReplayEngine(
      [migration('create extension postgis;')],
      {},
      linking(),
    ).catch((error: unknown) => error);
    expect(refusal).toBeUltimateError('X_SCHEMA_DUMP_DRIFT');
    const finding = replayFailure(refusal);
    // Carried whole to the finding: `replayFailure` must not swap in the migrate fix for it.
    expect(finding).toMatchObject({
      code: 'X_SCHEMA_DUMP_DRIFT',
      at: MIGRATIONS_DIR,
      fix: replayServerMissing(['postgis']).fix,
    });
    expect(finding.cause).toContain('extension "postgis"');
    expect(finding.cause).toContain('neither TEST_DATABASE_URL nor DATABASE_URL names one');
    expect(finding.fix).toStartWith('TEST_DATABASE_URL=postgres://');
    expect(finding.fix).toContain(' x db gen');
  });
});
