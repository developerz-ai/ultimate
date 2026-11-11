// Entity conformance · `lock` and `lockKey`: 20 racing read-modify-writes lose nothing, the read is
// the read path's (another org's id, a soft-deleted row: `X_NOT_FOUND`), a throw undoes what the
// callback wrote, a nested lock joins and holds to the outer end, a plain write waits for the
// holder. Lifted from `entity/src/lock-parity.test.ts`.

import { expect } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import type { Database, Tx } from '@ultimat3/entity';
import {
  CROSS_TENANT_SCOPE,
  crossTenant,
  entity,
  integer,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const counters = remember(
  entity('ec_l_counters', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      hits: integer(),
      deletedAt: timestamp().nullable(),
    },
  }),
);
const globals = remember(
  entity('ec_l_globals', { columns: { id: uuid().primaryKey(), label: text({ max: 10 }) } }),
);

const SET = { counters, globals };
type Db = Database<typeof SET>;
const [ORG_A, ORG_B] = [idAt('a'), idAt('b')];
const LOCK = ['lock'] as const;
const LOCK_TX = ['lock', 'transactions'] as const;

// A foreign failure handed to the subject: test input, never its verdict.
const CALLBACK_FAILED = new Error('the callback failed');

/** A turn of the event loop, so a read-modify-write has a window if the lock does not close it. */
const yieldNow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

const counter = (db: Db, id: string, hits = 0, deletedAt: Date | null = null) =>
  db.counters.insert({ id, orgId: ORG_A, hits, deletedAt });
const hitsOf = async (db: Db, id: string) =>
  (await db.counters.where({ id, orgId: ORG_A }).one())?.hits;

const lockChecks: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'lock: 20 racers end at 20',
    async (db) => {
      await counter(db, idAt('1'));
      await inOrg(ORG_A, () =>
        Promise.all(
          Array.from({ length: 20 }, () =>
            db.counters.lock(idAt('1'), async (row, tx) => {
              await yieldNow();
              await db.counters.update(idAt('1'), { hits: row.hits + 1 }, { tx });
            }),
          ),
        ),
      );
      expect(await hitsOf(db, idAt('1'))).toBe(20);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'lock reads as a read: another org, an unknown id, a soft-deleted row',
    async (db) => {
      await counter(db, idAt('2'));
      await counter(db, idAt('3'), 0, new Date(0));
      let ran = false;
      const touch = async () => {
        ran = true;
      };
      expect(await codeOf(() => inOrg(ORG_B, () => db.counters.lock(idAt('2'), touch)))).toBe(
        'X_NOT_FOUND',
      );
      expect(ran).toBe(false);
      expect(await codeOf(() => inOrg(ORG_A, () => db.counters.lock(idAt('ff'), () => 1)))).toBe(
        'X_NOT_FOUND',
      );
      expect(await codeOf(() => inOrg(ORG_A, () => db.counters.lock(idAt('3'), () => 1)))).toBe(
        'X_NOT_FOUND',
      );
      expect(await codeOf(() => db.counters.lock(idAt('2'), () => 1))).toBe('X_TENANCY_UNSCOPED');
      await db.globals.insert({ id: idAt('6'), label: 'x' });
      expect(await db.globals.lock(idAt('6'), (row) => row.label)).toBe('x');
    },
    LOCK,
  ),
  checkOver(
    SET,
    'lock: a throw rolls back what the callback wrote',
    async (db) => {
      await counter(db, idAt('4'), 7);
      const failing = () =>
        db.counters.lock(idAt('4'), async (_row, tx) => {
          await db.counters.update(idAt('4'), { hits: 99 }, { tx });
          throw CALLBACK_FAILED;
        });
      expect(await codeOf(() => inOrg(ORG_A, failing))).toBe('uncoded');
      expect(await hitsOf(db, idAt('4'))).toBe(7);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'lock answers what the callback answered, and may be taken again inside',
    async (db) => {
      await counter(db, idAt('5'), 1);
      const answer = await inOrg(ORG_A, () =>
        db.counters.lock(idAt('5'), (outer) =>
          db.counters.lock(idAt('5'), (inner) => `${outer.hits}-${inner.hits}`),
        ),
      );
      expect(answer).toBe('1-1');
    },
    LOCK,
  ),
  checkOver(
    SET,
    'a nested lock joins: the outer throw undoes its write',
    async (db) => {
      await counter(db, idAt('c1'));
      await counter(db, idAt('c2'), 5);
      const nested = inOrg(ORG_A, () =>
        db.counters.lock(idAt('c1'), async () => {
          await db.counters.lock(idAt('c2'), (_row, tx) =>
            db.counters.update(idAt('c2'), { hits: 6 }, { tx }),
          );
          throw CALLBACK_FAILED;
        }),
      );
      await nested.catch(() => undefined);
      expect(await hitsOf(db, idAt('c2'))).toBe(5);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'a nested lock is held to the outer end, not released with its own',
    async (db, raw) => {
      // Sequenced on what the driver REPORTS, never on a clock: the outer ends once the contender is
      // queued behind c4 (a held lock) or has run (a released one) — whichever the driver does. A
      // wall-clock window let a broken driver pass whenever its contender was slow.
      const waiters = raw.lockWaiters;
      if (waiters === undefined) return;
      await counter(db, idAt('c3'));
      await counter(db, idAt('c4'));
      const order: string[] = [];
      const nestedHeld = Promise.withResolvers<void>();
      let secondRan = false;
      const queuedOrRan = async (): Promise<void> => {
        while (!secondRan && (await waiters()) < 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      };
      await inOrg(ORG_A, () =>
        Promise.all([
          db.counters.lock(idAt('c3'), async () => {
            await db.counters.lock(idAt('c4'), () => nestedHeld.resolve());
            await queuedOrRan();
            order.push('outer ending');
          }),
          (async () => {
            await nestedHeld.promise;
            await db.counters.lock(idAt('c4'), () => {
              order.push('second ran');
              secondRan = true;
            });
          })(),
        ]),
      );
      expect(order).toEqual(['outer ending', 'second ran']);
    },
    LOCK,
  ),
  checkOver(
    SET,
    'a plain update waits for the holder: the locked write cannot overwrite it',
    async (db) => {
      await counter(db, idAt('c5'));
      await inOrg(ORG_A, async () => {
        const entered = Promise.withResolvers<void>();
        const locked = db.counters.lock(idAt('c5'), async (row, tx) => {
          entered.resolve();
          await yieldNow();
          await yieldNow();
          await db.counters.update(idAt('c5'), { hits: row.hits + 1 }, { tx });
        });
        await entered.promise;
        await Promise.all([locked, db.counters.update(idAt('c5'), { hits: 100 })]);
      });
      expect(await hitsOf(db, idAt('c5'))).toBe(100);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'a plain delete waits for the holder, and finds the row it kept',
    async (db) => {
      await counter(db, idAt('c6'));
      const order: string[] = [];
      await inOrg(ORG_A, async () => {
        const entered = Promise.withResolvers<void>();
        const locked = db.counters.lock(idAt('c6'), async () => {
          entered.resolve();
          await yieldNow();
          order.push('holder done');
        });
        await entered.promise;
        await Promise.all([
          locked,
          db.counters.delete(idAt('c6')).then(() => order.push('deleted')),
        ]);
      });
      expect(order).toEqual(['holder done', 'deleted']);
    },
    LOCK_TX,
  ),
];

const lockKeyChecks: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'lockKey: 20 racers on one key end at 20',
    async (db) => {
      await counter(db, idAt('7'));
      await inOrg(ORG_A, () =>
        Promise.all(
          Array.from({ length: 20 }, () =>
            db.counters.lockKey('recount', async (tx: Tx) => {
              const row = await db.counters.where({ id: idAt('7') }).one();
              await yieldNow();
              await db.counters.update(idAt('7'), { hits: (row?.hits ?? 0) + 1 }, { tx });
            }),
          ),
        ),
      );
      expect(await hitsOf(db, idAt('7'))).toBe(20);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'lockKey: a throw rolls back',
    async (db) => {
      await counter(db, idAt('8'), 3);
      await codeOf(() =>
        inOrg(ORG_A, () =>
          db.counters.lockKey('k', async (tx: Tx) => {
            await db.counters.update(idAt('8'), { hits: 4 }, { tx });
            throw CALLBACK_FAILED;
          }),
        ),
      );
      expect(await hitsOf(db, idAt('8'))).toBe(3);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'lockKey is scoped as a read, and a blank key is refused',
    async (db) => {
      expect(await codeOf(() => db.counters.lockKey('k', () => 1))).toBe('X_TENANCY_UNSCOPED');
      expect(await codeOf(() => db.counters.lockKey('k', () => 1, { orgId: ORG_A }))).toBe(
        'resolved',
      );
      expect(await codeOf(() => db.globals.lockKey('k', () => 1))).toBe('resolved');
      expect(await codeOf(() => db.globals.lockKey('  ', () => 1))).toBe('X_INVARIANT');
    },
    LOCK,
  ),
  checkOver(
    SET,
    'crossTenant takes the key an org would, when it names the org',
    async (db) => {
      const sweeper = userActor({ id: 's', orgId: ORG_A, scopes: [CROSS_TENANT_SCOPE] });
      const answer = await runWithContext(ctxOf({ actor: sweeper }), () =>
        crossTenant('nightly sweep', () =>
          db.counters.lockKey('sweep', () => 'held', { orgId: ORG_B }),
        ),
      );
      expect(answer).toBe('held');
    },
    LOCK,
  ),
];

export const LOCK_CHECKS: readonly EntityDriverCheck[] = [...lockChecks, ...lockKeyChecks];
