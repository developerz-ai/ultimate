// `withMigratorHold` on PGlite armed as `x dev` arms it: the pass runs as `x_migrator` on the one
// session while every other statement waits, and whatever ends the pass — success, a throwing
// migration, a transaction left open — the session serves as `x_app` again or serves nothing.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import type { DbClient, DbConnection, ReservableClient, SqlFragment } from '@ultimat3/db';
import {
  db,
  enableRowSecuritySql,
  holdMigratorRole,
  pgliteClient,
  raw,
  setDbClient,
  setTransactionSettings,
  sql,
} from '@ultimat3/db';
import { withMigratorHold } from './dev-db-migrator-hold';
import { armRowSecurity } from './row-security-boot';

const PGLITE_BOOT_MS = 30_000;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const asTenantA = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u1', orgId: A }) }), run);
const count = async (): Promise<number> =>
  (await db().one<{ n: number }>(sql`select count(*)::int as n from posts`))?.n ?? -1;
const roleOn = async (client: DbClient): Promise<string | undefined> =>
  (await client.one<{ role: string }>(sql`select current_user as role`))?.role;
const ownerOf = async (table: string): Promise<string | undefined> =>
  (
    await db().one<{ owner: string }>(
      sql`select pg_get_userbyid(relowner) as owner from pg_class where relname = ${table}`,
    )
  )?.owner;

/** `posts` (two tenants' rows) migrated as `x_migrator`, then the client armed as `x dev` arms it. */
async function served(): Promise<ReturnType<typeof pgliteClient>> {
  const client = pgliteClient();
  const release = await holdMigratorRole(client);
  await client.execute(raw('create table posts (id int primary key, org_id uuid not null)'));
  for (const statement of enableRowSecuritySql('posts', 'org_id', 'uuid')) {
    await client.execute(raw(statement));
  }
  await client.execute(raw(`insert into posts values (1, '${A}'), (2, '${B}')`));
  await release();
  setDbClient(client);
  await armRowSecurity(true, { embedded: true });
  return client;
}

/**
 * Whether `pending` is still unsettled after more event-loop turns than a queued PGlite statement
 * takes once it has the session — it never gets it, so no wall-clock wait is "long enough".
 */
async function stillWaiting(pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  pending.then(mark, mark);
  for (let turn = 0; turn < 200 && !settled; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return !settled;
}

const clients: { close(): Promise<void> }[] = [];
afterEach(() => {
  setTransactionSettings(undefined);
  setDbClient(undefined);
});
afterAll(async () => {
  // A client whose hold was never released (the two last tests) has nothing more to say.
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
});

describe('withMigratorHold', () => {
  test(
    'the pass is x_migrator, a read issued during it waits and sees one tenant, then x_app again',
    async () => {
      const client = await served();
      clients.push(client);
      let during: Promise<readonly [number, string | undefined]> | undefined;
      const inside = await withMigratorHold(async (pass) => {
        // The ambient client, as a concurrent request would use it: queued behind the hold.
        during = asTenantA(async () => [await count(), await roleOn(db())] as const);
        expect(pass.lock).toBe(false);
        const migrator = await roleOn(pass.client);
        await pass.client.execute(raw('create table notes (id int primary key)'));
        // The migrator bypasses row security: a concurrent read let through here would see 2.
        const seen = await pass.client.one<{ n: number }>(
          sql`select count(*)::int as n from posts`,
        );
        expect(await stillWaiting(during)).toBe(true);
        await pass.bootstrap();
        return { migrator, seen: seen?.n, bootstrap: await roleOn(pass.client) };
      });
      expect(inside.migrator).toBe('x_migrator');
      expect(inside.seen).toBe(2);
      expect(inside.bootstrap).not.toBe('x_migrator');
      expect(inside.bootstrap).not.toBe('x_app');
      expect(await during).toEqual([1, 'x_app']);
      expect(await ownerOf('notes')).toBe('x_migrator');
      expect(await roleOn(db())).toBe('x_app');
      expect(await asTenantA(count)).toBe(1);
      expect(await count()).toBe(0);
      // What the migrator created, the app role reaches: the grants follow the table.
      expect(await db().query(sql`select id from notes`)).toEqual([]);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a failing migration rejects as itself and leaves current_user = x_app',
    async () => {
      const client = await served();
      clients.push(client);
      const failed = await withMigratorHold(async (pass) => {
        await pass.client.execute(raw('create table half (id int primary key)'));
        await pass.client.execute(raw('select * from no_such_table'));
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(String((failed as { cause?: unknown })?.cause ?? failed)).toContain('no_such_table');
      expect(await roleOn(db())).toBe('x_app');
      expect(await asTenantA(count)).toBe(1);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a pass that dies inside an open transaction is rolled back before x_app is re-assumed',
    async () => {
      const client = await served();
      clients.push(client);
      const thrown = new TypeError('the pass died mid-transaction');
      await expect(
        withMigratorHold(async (pass) => {
          await pass.client.execute(raw('begin'));
          await pass.client.execute(raw('create table orphan (id int primary key)'));
          throw thrown;
        }),
      ).rejects.toBe(thrown);
      // `set role` inside a transaction is undone by its ROLLBACK: the role must outlive one.
      await client.execute(raw('rollback'));
      expect(await roleOn(client)).toBe('x_app');
      expect(await ownerOf('orphan')).toBeUndefined();
      expect(await asTenantA(count)).toBe(1);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a session that will not re-assume x_app stops serving: the turn is never given back',
    async () => {
      const client = await served();
      clients.push(client);
      let released = 0;
      const refusing: ReservableClient = {
        query: (fragment) => client.query(fragment),
        one: (fragment) => client.one(fragment),
        execute: (fragment) => client.execute(fragment),
        reserve: async (): Promise<DbConnection> => {
          const session = await client.reserve();
          return {
            query: (fragment) => session.query(fragment),
            one: (fragment) => session.one(fragment),
            execute: (fragment: SqlFragment) =>
              fragment.text.includes('set role "x_app"')
                ? Promise.reject(new TypeError('the session is gone'))
                : session.execute(fragment),
            release: () => {
              released += 1;
              session.release();
            },
            [Symbol.dispose]: () => session.release(),
          };
        },
      };
      let stops = 0;
      const refused = await withMigratorHold(async () => 'applied', {
        client: refusing,
        stopServing: () => {
          stops += 1;
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({
        code: 'X_DB_ROW_SECURITY_BYPASSED',
        fix: 'x stop --json && x dev',
      });
      expect((refused as { cause: string }).cause).toContain('the session is gone');
      expect(stops).toBe(1);
      expect(released).toBe(0);
      // The session is PGlite's superuser now; no statement may ever reach it.
      expect(await stillWaiting(asTenantA(count))).toBe(true);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a pass that leaves x_app exempt from row security stops serving too',
    async () => {
      const client = await served();
      clients.push(client);
      let stops = 0;
      const refused = await withMigratorHold(
        async (pass) => {
          await pass.bootstrap();
          await pass.client.execute(raw('create table loose (id int primary key)'));
          await pass.client.execute(raw('alter table loose enable row level security'));
          await pass.client.execute(raw('alter table loose owner to x_app'));
        },
        {
          stopServing: () => {
            stops += 1;
          },
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({ code: 'X_DB_ROW_SECURITY_BYPASSED' });
      expect(stops).toBe(1);
      expect(await stillWaiting(asTenantA(count))).toBe(true);
    },
    PGLITE_BOOT_MS,
  );
});
