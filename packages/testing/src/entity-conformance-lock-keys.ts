// Entity conformance · `lockKeys(keys, fn)`: several keys held for one callback in one transaction,
// taken in sorted order so two callers naming them in opposite orders never deadlock, each key the
// very lock `lockKey` takes (one holder blocks the other), an org's keys never another org's, a
// throw undoing what the callback wrote, and the read path's scope and the blank-key refusal kept.

import { expect } from 'bun:test';
import type { Database, Tx } from '@ultimat3/entity';
import { entity, integer, text, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck, EntityDriverRun } from './entity-driver-conformance';

const tallies = remember(
  entity('ec_lk_tallies', {
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), hits: integer() },
  }),
);
const shared = remember(
  entity('ec_lk_shared', { columns: { id: uuid().primaryKey(), label: text({ max: 10 }) } }),
);

const SET = { tallies, shared };
type Db = Database<typeof SET>;
const [ORG_A, ORG_B] = [idAt('ba'), idAt('bb')];
const LOCK = ['lock'] as const;
const LOCK_TX = ['lock', 'transactions'] as const;
const RACERS = 20;

// A foreign failure handed to the subject: test input, never its verdict.
const CALLBACK_FAILED = new Error('the callback failed');

/** A turn of the event loop, so a read-modify-write has a window if the lock does not close it. */
const yieldNow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

const tally = (db: Db, id: string, hits = 0) => db.tallies.insert({ id, orgId: ORG_A, hits });
const hitsOf = async (db: Db, id: string) =>
  (await db.tallies.where({ id, orgId: ORG_A }).one())?.hits;

/** Read, yield, write: loses updates unless every caller is held out of the window. */
const bump = async (db: Db, id: string, tx: Tx): Promise<void> => {
  const row = await db.tallies.where({ id }).one();
  await yieldNow();
  await db.tallies.update(id, { hits: (row?.hits ?? 0) + 1 }, { tx });
};

/**
 * Until `settled()` or a contender is queued on a lock — what the driver REPORTS, never a clock. A
 * check that stopped on a window of its own let a slow contender look like a blocked one.
 */
const queuedOr = async (waiters: () => number | Promise<number>, settled: () => boolean) => {
  while (!settled() && (await waiters()) < 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const hold = (raw: EntityDriverRun) => raw.lockWaiters;

const checks: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    `lockKeys: ${RACERS} racers naming two keys in opposite orders end at ${RACERS}, no deadlock`,
    async (db) => {
      await tally(db, idAt('b1'));
      await inOrg(ORG_A, () =>
        Promise.all(
          Array.from({ length: RACERS }, (_, index) =>
            db.tallies.lockKeys(index % 2 === 0 ? ['left', 'right'] : ['right', 'left'], (tx) =>
              bump(db, idAt('b1'), tx),
            ),
          ),
        ),
      );
      expect(await hitsOf(db, idAt('b1'))).toBe(RACERS);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'lockKeys answers the callback’s answer, and a throw rolls back all it wrote',
    async (db) => {
      await tally(db, idAt('b2'), 3);
      await tally(db, idAt('b3'), 3);
      const answer = await inOrg(ORG_A, () => db.tallies.lockKeys(['a', 'b'], () => 'held'));
      const thrown = await inOrg(ORG_A, () =>
        db.tallies
          .lockKeys(['a', 'b'], async (tx) => {
            await db.tallies.update(idAt('b2'), { hits: 4 }, { tx });
            await db.tallies.update(idAt('b3'), { hits: 4 }, { tx });
            throw CALLBACK_FAILED;
          })
          .then(
            () => 'resolved',
            (error: unknown) => error,
          ),
      );
      expect([answer, thrown]).toEqual(['held', CALLBACK_FAILED]);
      expect([await hitsOf(db, idAt('b2')), await hitsOf(db, idAt('b3'))]).toEqual([3, 3]);
    },
    LOCK_TX,
  ),
  checkOver(
    SET,
    'every key lockKeys names is the lock lockKey takes: a holder of either set waits the other',
    async (db, raw) => {
      const waiters = hold(raw);
      // PGlite: one connection, so a contender waits on the client where no query sees it.
      if (waiters === undefined) return;
      for (const [holder, contender] of [
        ['lockKeys', 'lockKey'],
        ['lockKey', 'lockKeys'],
      ] as const) {
        const order: string[] = [];
        const entered = Promise.withResolvers<void>();
        let contenderRan = false;
        const take = (which: 'lockKey' | 'lockKeys', fn: () => unknown) =>
          which === 'lockKey'
            ? db.tallies.lockKey('second', fn)
            : db.tallies.lockKeys(['first', 'second'], fn);
        await inOrg(ORG_A, () =>
          Promise.all([
            take(holder, async () => {
              entered.resolve();
              await queuedOr(waiters, () => contenderRan);
              order.push('holder ending');
            }),
            (async () => {
              await entered.promise;
              await take(contender, () => {
                contenderRan = true;
                order.push('contender ran');
              });
            })(),
          ]),
        );
        expect([holder, order]).toEqual([holder, ['holder ending', 'contender ran']]);
      }
    },
    LOCK,
  ),
  checkOver(
    SET,
    'org A holding its keys never blocks org B naming the same keys',
    async (db, raw) => {
      const waiters = hold(raw);
      if (waiters === undefined) return;
      const order: string[] = [];
      const entered = Promise.withResolvers<void>();
      let otherRan = false;
      await Promise.all([
        inOrg(ORG_A, () =>
          db.tallies.lockKeys(['same', 'keys'], async () => {
            entered.resolve();
            await queuedOr(waiters, () => otherRan);
            order.push('org A ending');
          }),
        ),
        (async () => {
          await entered.promise;
          await inOrg(ORG_B, () =>
            db.tallies.lockKeys(['keys', 'same'], () => {
              otherRan = true;
              order.push('org B ran');
            }),
          );
        })(),
      ]);
      expect(order).toEqual(['org B ran', 'org A ending']);
    },
    LOCK,
  ),
  checkOver(
    SET,
    'lockKeys is scoped as a read; no key, a blank key or past 64 distinct keys is refused',
    async (db) => {
      let ran = 0;
      const fn = () => {
        ran += 1;
      };
      const keys = (n: number) => Array.from({ length: n }, (_, index) => `k${index}`);
      const answers = [
        await codeOf(() => db.tallies.lockKeys(['k'], fn)),
        await codeOf(() => db.tallies.lockKeys(['k'], fn, { orgId: ORG_A })),
        await codeOf(() => db.shared.lockKeys(['k', 'j', 'k'], fn)),
        await codeOf(() => db.shared.lockKeys([...keys(64), 'k0'], fn)),
        await codeOf(() => db.shared.lockKeys([], fn)),
        await codeOf(() => db.shared.lockKeys(['k', '  '], fn)),
        await codeOf(() => db.shared.lockKeys(keys(65), fn)),
      ];
      expect([answers, ran]).toEqual([
        [
          'X_TENANCY_UNSCOPED',
          'resolved',
          'resolved',
          'resolved',
          'X_INVARIANT',
          'X_INVARIANT',
          'X_INVARIANT',
        ],
        3,
      ]);
    },
    LOCK,
  ),
];

export const LOCK_KEYS_CHECKS: readonly EntityDriverCheck[] = checks;
