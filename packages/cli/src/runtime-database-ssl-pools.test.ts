// `database.ssl: true` on the pools that never call `startDb`: `x doctor`'s probes, `x db branch`,
// `x deploy verify`'s queue read and the replicator's env. The same rule as the boot's own pool —
// `sslmode=require` only where the URL and `PGSSLMODE` state none.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs'; // why: Bun has no temp-directory primitive.
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove.
import { tmpdir } from 'node:os'; // why: Bun exposes no temp root.
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { REQUIRED_BUN } from './app-root';
import { runBranchCommand } from './cmd-db-branch';
import type { CommandContext } from './command';
import { probeFor } from './doctor-probe';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { envWithAppTls, withAppTls } from './runtime-database-ssl';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;
const realDatabaseUrl = process.env['DATABASE_URL'];
const roots: string[] = [];
const URL_BARE = 'postgres://app@db.internal:5432/app';

afterEach(async () => {
  host.Bun.SQL = realBunSql;
  if (realDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = realDatabaseUrl;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every URL a pool was opened on; each statement answers nothing. */
const recordPools = (): { readonly urls: string[] } => {
  const seen = { urls: [] as string[] };
  host.Bun.SQL = class {
    constructor(url: string) {
      seen.urls.push(url);
    }
    async unsafe(): Promise<unknown> {
      return [];
    }
    async close(): Promise<void> {}
  };
  return seen;
};

const appRoot = async (ssl: boolean): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'x-db-ssl-pools-'));
  roots.push(root);
  await Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { name: 'ssl-fixture', database: { ssl: ${ssl} } };\n`,
  );
  return root;
};

const sslModeOf = (url: string | undefined): string | null =>
  new URL(url ?? expect.unreachable('no pool was opened')).searchParams.get('sslmode');

describe('unit · database.ssl on a URL startDb never sees', () => {
  test('requires TLS where none is stated, and only for an app that declares the switch', async () => {
    const on = await appRoot(true);
    expect(sslModeOf(await withAppTls(on, URL_BARE, {}))).toBe('require');
    expect(await withAppTls(await appRoot(false), URL_BARE, {})).toBe(URL_BARE);
    expect(await withAppTls(undefined, URL_BARE, {})).toBe(URL_BARE);
  });

  test('a stated mode, PGSSLMODE and the embedded directory are left as written', async () => {
    const on = await appRoot(true);
    const stated = `${URL_BARE}?sslmode=verify-full`;
    expect(await withAppTls(on, stated, {})).toBe(stated);
    expect(await withAppTls(on, URL_BARE, { PGSSLMODE: 'disable' })).toBe(URL_BARE);
    expect(await withAppTls(on, '/app/.x/pgdata', {})).toBe('/app/.x/pgdata');
    expect(await withAppTls(on, undefined, {})).toBeUndefined();
  });

  test("the replicator's env: REPLICATION_URL and DATABASE_URL both, nothing else moved", async () => {
    const env = { DATABASE_URL: URL_BARE, REPLICATION_URL: URL_BARE, REPLICATION_SLOT: 's' };
    const next = await envWithAppTls(await appRoot(true), env);
    expect(sslModeOf(next['DATABASE_URL'])).toBe('require');
    expect(sslModeOf(next['REPLICATION_URL'])).toBe('require');
    expect(next['REPLICATION_SLOT']).toBe('s');
    expect(await envWithAppTls(await appRoot(false), env)).toEqual(env);
  });
});

describe('unit · database.ssl reaches the commands that open their own pool', () => {
  test("x doctor's database probe dials with sslmode=require", async () => {
    const root = await appRoot(true);
    const pools = recordPools();
    process.env['DATABASE_URL'] = URL_BARE;
    await probeFor(root, REQUIRED_BUN, 3000, {}).database();
    expect(sslModeOf(pools.urls[0])).toBe('require');
  });

  test('x db branch list dials with sslmode=require', async () => {
    const root = await appRoot(true);
    const pools = recordPools();
    const ctx: CommandContext = {
      args: parseArgs(['db', 'branch', 'list'], SPECS),
      cwd: root,
      runner: exec,
      env: { DATABASE_URL: URL_BARE },
      bunVersion: REQUIRED_BUN,
    };
    await runBranchCommand(ctx, root);
    expect(sslModeOf(pools.urls[0])).toBe('require');
  });
});
