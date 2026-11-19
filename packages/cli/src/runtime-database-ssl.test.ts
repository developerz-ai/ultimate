// `database.ssl: true` reaches the pool the boot opens: TLS is required where the URL says nothing,
// and a URL (or `PGSSLMODE`) that states its own mode is never overridden.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs'; // why: Bun has no temp-directory primitive.
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove.
import { tmpdir } from 'node:os'; // why: Bun exposes no temp root.
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { setDbClient } from '@ultimat3/db';
import type { DevServices } from './runtime-bindings';
import { databaseSslOf, withRequiredTls } from './runtime-database-ssl';
import { startDb, startQueue } from './runtime-queue';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;
const roots: string[] = [];

afterEach(async () => {
  host.Bun.SQL = realBunSql;
  setDbClient(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

const external = (url: string, root = '/app'): DevServices =>
  ({ root, db: { mode: 'external', url } }) as unknown as DevServices;

const sslModeOf = (url: string | undefined): string | null =>
  new URL(url ?? expect.unreachable('no pool was opened')).searchParams.get('sslmode');

const appRoot = async (database: string): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'x-db-ssl-'));
  roots.push(root);
  await Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { name: 'ssl-fixture', database: ${database} };\n`,
  );
  return root;
};

describe('unit · database.ssl', () => {
  test('database.ssl: true requires TLS on a URL that states no sslmode', async () => {
    const pools = recordPools();
    const { client } = startDb(external('postgres://app@db.internal:5432/app'), {}, true);
    await client.ping();
    expect(sslModeOf(pools.urls[0])).toBe('require');
  });

  test('and on the standby the same boot opens', async () => {
    const pools = recordPools();
    const { replica } = startDb(
      external('postgres://app@db.internal:5432/app'),
      { DATABASE_REPLICA_URL: 'postgres://reader@replica.internal:5432/app' },
      true,
    );
    await replica?.ping();
    expect(pools.urls[0]).toContain('replica.internal');
    expect(sslModeOf(pools.urls[0])).toBe('require');
  });

  test('database.ssl: false leaves the URL as written', async () => {
    const pools = recordPools();
    const { client } = startDb(external('postgres://app@db.internal:5432/app'), {}, false);
    await client.ping();
    expect(sslModeOf(pools.urls[0])).toBeNull();
  });

  test("a URL's own sslmode is never overridden: neither downgraded nor weakened", () => {
    for (const mode of ['disable', 'prefer', 'verify-ca', 'verify-full']) {
      const url = `postgres://app@db.internal:5432/app?sslmode=${mode}`;
      expect(withRequiredTls(url, {})).toBe(url);
    }
  });

  test('PGSSLMODE in the boot env is the operator stating the mode: nothing is added', () => {
    const url = 'postgres://app@db.internal:5432/app';
    expect(withRequiredTls(url, { PGSSLMODE: 'verify-full' })).toBe(url);
    expect(sslModeOf(withRequiredTls(url, { PGSSLMODE: ' ' }))).toBe('require');
  });

  test('a value that is not a URL is handed on untouched, for the client to refuse by name', () => {
    expect(withRequiredTls('db.internal', {})).toBe('db.internal');
  });

  // The wiring, not the rule: `startQueue` is every boot path's opener, and the switch was
  // validated and documented while this call passed nothing.
  test('startQueue opens the pool the app declared: ssl true, TLS required', async () => {
    const pools = recordPools();
    const root = await appRoot('{ ssl: true }');
    const services = external('postgres://app@db.internal:5432/app', root);
    // The recording pool answers no real catalog, so the boot past the ping may refuse: only the
    // URL the pool was opened on is under test.
    const queue = await startQueue(services, undefined, {}, 'ensure').catch(() => undefined);
    await queue?.stop();
    expect(sslModeOf(pools.urls[0])).toBe('require');
  });

  test('the switch is read from app.config.ts, and only for an external database', async () => {
    const on = await appRoot('{ ssl: true }');
    expect(await databaseSslOf(external('postgres://app@db.internal/app', on))).toBe(true);
    expect(
      await databaseSslOf({ root: on, db: { mode: 'embedded' } } as unknown as DevServices),
    ).toBe(false);
    const off = await appRoot('{}');
    expect(await databaseSslOf(external('postgres://app@db.internal/app', off))).toBe(false);
    // No app.config.ts at all: not an app, and nothing was declared.
    expect(await databaseSslOf(external('postgres://app@db.internal/app', '/nonexistent'))).toBe(
      false,
    );
  });
});
