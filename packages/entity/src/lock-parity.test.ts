// `db.<table>.lock` and `.lockKey` on both drivers, one body each: memory and an embedded Postgres.
// 20 read-modify-writes through the plain handle lose updates on either (`memory got 1`, `Postgres
// got 2`, measured 2026-11-02); through `lock` they cannot. PGlite is one connection, so what it
// proves is the driver's meaning, and `lock.live.test.ts` is what proves the same against real ones.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import {
  driverError,
  generateMigration,
  pgliteClient,
  raw,
  setDbClient,
  setStatementObserver,
  statementsOf,
} from '@ultimat3/db';
import { integer, text, timestamp, uuid } from './columns';
import { CROSS_TENANT_SCOPE, crossTenant } from './cross-tenant';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { memoryLocks } from './memory-lock';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import type { Tx } from './repo';

// A foreign failure handed to the subject: test input, never its verdict.
const CALLBACK_FAILED = new Error('the callback failed');
const OUTER_CALLBACK_FAILED = new Error('the outer callback failed');

const PGLITE_BOOT_MS = 30_000;

const counters = entity('lp_counters', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    hits: integer(),
    deletedAt: timestamp().nullable(),
  },
});

const globals = entity('lp_globals', {
  columns: { id: uuid().primaryKey(), label: text({ max: 10 }) },
});

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG_A = idAt('a');
const ORG_B = idAt('b');

const handle = (driver: Driver) => database({ counters, globals }, { driver });
type Handle = ReturnType<typeof handle>;

const inOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u', orgId }) }), work);

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'accepted';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
};

const drivers: { name: string; db: Handle }[] = [];

beforeAll(async () => {
  const client = await pgliteClient();
  setDbClient(client);
  const { up } = generateMigration({
    entities: [counters.$describe(), globals.$describe()],
    name: 'lock parity',
  });
  for (const statement of statementsOf(up)) await client.execute(raw(statement));
  drivers.push({ name: 'memory', db: handle(memoryDriver()) });
  drivers.push({ name: 'postgres', db: handle(postgresDriver()) });
}, PGLITE_BOOT_MS);

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const eachDriver = (name: string, body: (db: Handle) => Promise<void>) => {
  test(name, async () => {
    for (const driver of drivers) await body(driver.db);
  });
};

/** A turn of the event loop, so a read-modify-write has a window if the lock does not close it. */
const yieldNow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('unit · lock', () => {
  eachDriver('20 racers end at 20', async (db) => {
    const id = idAt('1');
    await db.counters.insert({ id, orgId: ORG_A, hits: 0, deletedAt: null });
    await inOrg(ORG_A, () =>
      Promise.all(
        Array.from({ length: 20 }, () =>
          db.counters.lock(id, async (row, tx) => {
            await yieldNow();
            await db.counters.update(id, { hits: row.hits + 1 }, { tx });
          }),
        ),
      ),
    );
    const stored = await db.counters.where({ id, orgId: ORG_A }).one();
    expect(stored?.hits).toBe(20);
  });

  eachDriver('another org’s id is absent, exactly as a read', async (db) => {
    const id = idAt('2');
    await db.counters.insert({ id, orgId: ORG_A, hits: 0, deletedAt: null });
    let ran = false;
    const code = await codeOf(() =>
      inOrg(ORG_B, () =>
        db.counters.lock(id, async () => {
          ran = true;
        }),
      ),
    );
    expect(code).toBe('X_NOT_FOUND');
    expect(ran).toBe(false);
  });

  eachDriver('an unknown id and a soft-deleted row are X_NOT_FOUND', async (db) => {
    const id = idAt('3');
    await db.counters.insert({ id, orgId: ORG_A, hits: 0, deletedAt: new Date(0) });
    await inOrg(ORG_A, async () => {
      expect(await codeOf(() => db.counters.lock(idAt('ff'), () => 1))).toBe('X_NOT_FOUND');
      expect(await codeOf(() => db.counters.lock(id, () => 1))).toBe('X_NOT_FOUND');
    });
  });

  eachDriver('no actor and no org is X_TENANCY_UNSCOPED', async (db) => {
    expect(await codeOf(() => db.counters.lock(idAt('1'), () => 1))).toBe('X_TENANCY_UNSCOPED');
  });

  eachDriver('a throw rolls back what the callback wrote', async (db) => {
    const id = idAt('4');
    await db.counters.insert({ id, orgId: ORG_A, hits: 7, deletedAt: null });
    const code = await codeOf(() =>
      inOrg(ORG_A, () =>
        db.counters.lock(id, async (_row, tx) => {
          await db.counters.update(id, { hits: 99 }, { tx });
          throw CALLBACK_FAILED;
        }),
      ),
    );
    expect(code).toBe('uncoded');
    expect((await db.counters.where({ id, orgId: ORG_A }).one())?.hits).toBe(7);
  });

  eachDriver('it answers what the callback answered, and may be taken again inside', async (db) => {
    const id = idAt('5');
    await db.counters.insert({ id, orgId: ORG_A, hits: 1, deletedAt: null });
    const answer = await inOrg(ORG_A, () =>
      db.counters.lock(id, (outer) =>
        db.counters.lock(id, (inner) => `${outer.hits}-${inner.hits}`),
      ),
    );
    expect(answer).toBe('1-1');
  });

  eachDriver('an entity with no tenant needs no actor', async (db) => {
    await db.globals.insert({ id: idAt('6'), label: 'x' });
    expect(await db.globals.lock(idAt('6'), (row) => row.label)).toBe('x');
    expect(await codeOf(() => db.globals.lock(idAt('fe'), () => 1))).toBe('X_NOT_FOUND');
  });
});

describe('unit · what a write inside or beside a lock means', () => {
  eachDriver(
    'a nested lock with no options joins: the outer throw undoes its write',
    async (db) => {
      const outer = idAt('c1');
      const inner = idAt('c2');
      await db.counters.insertAll([
        { id: outer, orgId: ORG_A, hits: 0, deletedAt: null },
        { id: inner, orgId: ORG_A, hits: 5, deletedAt: null },
      ]);
      await inOrg(ORG_A, () =>
        db.counters.lock(outer, async () => {
          await db.counters.lock(inner, (_row, tx) =>
            db.counters.update(inner, { hits: 6 }, { tx }),
          );
          throw OUTER_CALLBACK_FAILED;
        }),
      ).catch(() => undefined);
      expect((await db.counters.where({ id: inner, orgId: ORG_A }).one())?.hits).toBe(5);
    },
  );

  eachDriver('a nested lock is held to the outer end, not released with its own', async (db) => {
    const outer = idAt('c3');
    const inner = idAt('c4');
    await db.counters.insertAll([
      { id: outer, orgId: ORG_A, hits: 0, deletedAt: null },
      { id: inner, orgId: ORG_A, hits: 0, deletedAt: null },
    ]);
    const order: string[] = [];
    await inOrg(ORG_A, () =>
      Promise.all([
        db.counters.lock(outer, async () => {
          await db.counters.lock(inner, () => undefined);
          await yieldNow();
          await yieldNow();
          order.push('outer ending');
        }),
        (async () => {
          await yieldNow();
          await db.counters.lock(inner, () => {
            order.push('second ran');
          });
        })(),
      ]),
    );
    expect(order).toEqual(['outer ending', 'second ran']);
  });

  eachDriver(
    'a plain update waits for the holder: the locked write cannot overwrite it',
    async (db) => {
      const id = idAt('c5');
      await db.counters.insert({ id, orgId: ORG_A, hits: 0, deletedAt: null });
      await inOrg(ORG_A, async () => {
        const entered = Promise.withResolvers<void>();
        const locked = db.counters.lock(id, async (row, tx) => {
          entered.resolve();
          await yieldNow();
          await yieldNow();
          await db.counters.update(id, { hits: row.hits + 1 }, { tx });
        });
        await entered.promise;
        await Promise.all([locked, db.counters.update(id, { hits: 100 })]);
      });
      expect((await db.counters.where({ id, orgId: ORG_A }).one())?.hits).toBe(100);
    },
  );

  test('memory: a plain delete waits too, and finds the row the holder kept', async () => {
    const db = drivers.find((driver) => driver.name === 'memory')?.db;
    if (db === undefined) expect.unreachable('memory is first');
    const id = idAt('c6');
    await db.counters.insert({ id, orgId: ORG_A, hits: 0, deletedAt: null });
    const order: string[] = [];
    await inOrg(ORG_A, async () => {
      const entered = Promise.withResolvers<void>();
      const locked = db.counters.lock(id, async () => {
        entered.resolve();
        await yieldNow();
        order.push('holder done');
      });
      await entered.promise;
      const removed = db.counters.delete(id).then(() => order.push('deleted'));
      await Promise.all([locked, removed]);
    });
    expect(order).toEqual(['holder done', 'deleted']);
  });
});

describe('unit · one code for a wait past its bound', () => {
  test('memory answers what the Postgres funnel makes of a 57014, statement_timeout', async () => {
    const locks = memoryLocks(5);
    const release = Promise.withResolvers<void>();
    const held = locks.run('k', undefined, () => release.promise);
    const waited = await locks.run('k', undefined, () => 1).catch((error: unknown) => error);
    release.resolve();
    await held;
    expect(isUltimateError(waited) ? waited.code : waited).toBe('X_DB_STATEMENT_TIMEOUT');
    expect(isUltimateError(waited) ? waited.code : waited).toBe(
      driverError('statement', { code: '57014' }).code,
    );
  });
});

describe('unit · what a diagnostic reads', () => {
  test('the lock statement names itself; what the callback sends names its own call', async () => {
    const db = drivers.find((driver) => driver.name === 'postgres')?.db;
    if (db === undefined) expect.unreachable('postgres boots first');
    const id = idAt('9');
    await db.counters.insert({ id, orgId: ORG_A, hits: 0, deletedAt: null });
    const seen: string[] = [];
    setStatementObserver({
      onStatement: ({ attribution }) => {
        if (attribution?.entity === 'lp_counters') seen.push(attribution.op);
      },
    });
    try {
      await inOrg(ORG_A, () =>
        db.counters.lock(id, (_row, tx) => db.counters.update(id, { hits: 1 }, { tx })),
      );
      await inOrg(ORG_A, () => db.counters.lockKey('k', () => undefined));
    } finally {
      setStatementObserver(undefined);
    }
    expect(seen).toEqual(['lock', 'update', 'lockKey']);
  });
});

describe('unit · lockKey', () => {
  eachDriver('20 racers on one key end at 20', async (db) => {
    const id = idAt('7');
    await db.counters.insert({ id, orgId: ORG_A, hits: 0, deletedAt: null });
    await inOrg(ORG_A, () =>
      Promise.all(
        Array.from({ length: 20 }, () =>
          db.counters.lockKey('recount', async (tx: Tx) => {
            const row = await db.counters.where({ id }).one();
            await yieldNow();
            await db.counters.update(id, { hits: (row?.hits ?? 0) + 1 }, { tx });
          }),
        ),
      ),
    );
    expect((await db.counters.where({ id, orgId: ORG_A }).one())?.hits).toBe(20);
  });

  eachDriver('a throw rolls back', async (db) => {
    const id = idAt('8');
    await db.counters.insert({ id, orgId: ORG_A, hits: 3, deletedAt: null });
    await codeOf(() =>
      inOrg(ORG_A, () =>
        db.counters.lockKey('k', async (tx: Tx) => {
          await db.counters.update(id, { hits: 4 }, { tx });
          throw CALLBACK_FAILED;
        }),
      ),
    );
    expect((await db.counters.where({ id, orgId: ORG_A }).one())?.hits).toBe(3);
  });

  eachDriver('scoped as a read: no actor is X_TENANCY_UNSCOPED', async (db) => {
    expect(await codeOf(() => db.counters.lockKey('k', () => 1))).toBe('X_TENANCY_UNSCOPED');
    expect(await codeOf(() => db.counters.lockKey('k', () => 1, { orgId: ORG_A }))).toBe(
      'accepted',
    );
    expect(await codeOf(() => db.globals.lockKey('k', () => 1))).toBe('accepted');
  });

  eachDriver('a blank key is refused', async (db) => {
    expect(await codeOf(() => db.globals.lockKey('  ', () => 1))).toBe('X_INVARIANT');
  });

  eachDriver('crossTenant takes the key an org would, when it names the org', async (db) => {
    const sweeper = userActor({ id: 's', orgId: ORG_A, scopes: [CROSS_TENANT_SCOPE] });
    const answer = await runWithContext(ctxOf({ actor: sweeper }), () =>
      crossTenant('nightly sweep', () =>
        db.counters.lockKey('sweep', () => 'held', { orgId: ORG_B }),
      ),
    );
    expect(answer).toBe('held');
  });
});
