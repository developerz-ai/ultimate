// Each upgrade fixture owns a fresh database on the test server: the gate's suites leave the shared
// one dirty (a history table, a ledger row), and fixture N used to meet fixture N-1's ledger. No
// server, no database here: the admin statements go to a recording seam.

import { describe, expect, test } from 'bun:test';
// why: Bun has no recursive remove; the fixture's work tree is removed here.
import { rmSync } from 'node:fs';
// why: Bun exposes no path-dirname primitive.
import { dirname } from 'node:path';
import { dbUnavailable } from '@ultimat3/db';
import { fixtureDatabaseName, openFixtureDatabase } from './upgrade-fixtures-database';
import { runFixture } from './upgrade-fixtures-run';

const SERVER = 'postgres://ultimate:ultimate@localhost:5432/postgres';

const recording = (refuseCreate = false) => {
  const sent: string[] = [];
  const admin = async (statement: string): Promise<void> => {
    sent.push(statement);
    if (refuseCreate && statement.startsWith('create database')) {
      // The server's refusal, as a coded error the way the driver hands one over.
      throw dbUnavailable('database already exists');
    }
  };
  return { sent, admin };
};

describe('unit · the database an upgrade fixture runs against', () => {
  test('no test server: the embedded default, and no statement sent', async () => {
    const { sent, admin } = recording();
    const opened = await openFixtureDatabase({ PATH: '/bin' }, '31.20.0', admin);
    expect(opened).toMatchObject({ env: { PATH: '/bin' } });
    expect('env' in opened ? opened.env['DATABASE_URL'] : 'refused').toBeUndefined();
    if ('close' in opened) await opened.close();
    expect(sent).toEqual([]);
  });

  test('a test server: a fresh database per fixture, its URL as DATABASE_URL, dropped on close', async () => {
    const { sent, admin } = recording();
    const env = { TEST_DATABASE_URL: SERVER, DATABASE_URL: SERVER };
    const one = await openFixtureDatabase(env, '31.20.0', admin);
    const two = await openFixtureDatabase(env, '31.20.0', admin);
    if (!('env' in one) || !('env' in two)) return expect.unreachable('both fixtures open');
    const name = new URL(one.env['DATABASE_URL'] ?? '').pathname.slice(1);
    expect(name).toStartWith('x_upgrade_fixture_31_20_0_');
    expect(two.env['DATABASE_URL']).not.toBe(one.env['DATABASE_URL']);
    expect(one.env['TEST_DATABASE_URL']).toBe(SERVER);
    await one.close();
    expect(sent).toContain(`create database "${name}"`);
    expect(sent.at(-1)).toBe(`drop database if exists "${name}" with (force)`);
  });

  test('a name that already exists is refused, and the database that was there is never dropped', async () => {
    const { sent, admin } = recording(true);
    const opened = await openFixtureDatabase({ TEST_DATABASE_URL: SERVER }, '31.20.0', admin);
    expect('refused' in opened && opened.refused).toContain(
      'could not create the fixture database',
    );
    expect(sent.filter((statement) => statement.startsWith('drop'))).toEqual([]);
  });

  test('the name is a plain identifier within Postgres` 63 bytes', () => {
    const name = fixtureDatabaseName('31.20.0-rc.1+build', 'ABCDEF0123456789');
    expect(name).toBe('x_upgrade_fixture_31_20_0_rc_1_build_abcdef01');
    expect(fixtureDatabaseName('9'.repeat(80), 'aa').length).toBeLessThanOrEqual(63);
  });
});

describe('unit · runFixture opens its database first', () => {
  test('a refused database stops the fixture at setup, before anything is scaffolded', async () => {
    const { sent, admin } = recording(true);
    const run = await runFixture(
      {
        root: '/nonexistent',
        version: '31.20.0',
        head: '31.30.0',
        packed: [],
        cacheDir: '/nonexistent',
        env: { TEST_DATABASE_URL: SERVER },
        before: false,
        verify: false,
        headScaffold: undefined,
      },
      admin,
    );
    rmSync(dirname(run.dir), { recursive: true, force: true });
    expect(run.unbuilt?.stage).toBe('setup');
    expect(run.unbuilt?.output).toContain('could not create the fixture database');
    expect(run.stages).toEqual({});
    expect(sent).toHaveLength(1);
  });
});
