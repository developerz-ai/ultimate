// The entity driver suite over `memoryDriver()` — the reference every other driver is held to —
// and over the toy `defineDriver` store, which declares no capability. Then the proof the suite can
// fail: a memory driver that writes a patch's `undefined` as NULL, the bug the suite exists for.

import { describe, expect, test } from 'bun:test';
import type { Driver, EntityCore, Repo } from '@ultimat3/entity';
import { memoryDriver, memoryTransactor } from '@ultimat3/entity';
import { DRIVER_CAPABILITIES, defineDriver, memoryLockWaiters } from '@ultimat3/entity/adapter';
import { ENTITY_DRIVER_CHECKS } from './entity-conformance-checks';
import { toyStore } from './entity-conformance-toy-fixture';
import type { EntityDriverSubject } from './entity-driver-conformance';
import { entityDriverConformance, runEntityDriverCheck } from './entity-driver-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory entity driver'), () => {
  behavesLike(entityDriverConformance, () => ({
    open: () => memoryDriver(),
    capabilities: DRIVER_CAPABILITIES,
    foreignKeys: false,
    history: true,
    lockWaiters: memoryLockWaiters,
  }));
});

const toy: EntityDriverSubject = {
  open: () => defineDriver(toyStore()),
  capabilities: [],
  foreignKeys: false,
};

describe(testName('unit', 'a defineDriver store declaring no capability'), () => {
  behavesLike(entityDriverConformance, () => toy);
});

/** Every patch value spelled out, `undefined` as NULL: correct for every write that names one. */
const nullingUndefined = (): Driver => {
  const inner = memoryDriver();
  return {
    ...inner,
    repo: <Row>(entity: EntityCore<Row>): Repo<Row> => {
      const repo = inner.repo(entity);
      const spelled = (patch: object) =>
        Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [key, value ?? null]),
        ) as never;
      return {
        ...repo,
        update: (id, patch, options) => repo.update(id, spelled(patch), options),
        updateWhere: (filter, patch, options) => repo.updateWhere(filter, spelled(patch), options),
      };
    },
  };
};

const broken: EntityDriverSubject = {
  open: () => nullingUndefined(),
  capabilities: DRIVER_CAPABILITIES,
  foreignKeys: false,
};

const named = (name: string) => {
  const check = ENTITY_DRIVER_CHECKS.find((each) => each.name === name);
  if (check === undefined) return expect.unreachable(`no check named ${name}`);
  return check;
};

describe(testName('unit', 'a driver that writes undefined as NULL fails conformance'), () => {
  test('it fails the undefined-is-absent checks and passes one that never patches', async () => {
    for (const name of [
      'update keeps a column the patch names as undefined',
      'updateWhere keeps a column the patch names as undefined',
    ]) {
      await expect(runEntityDriverCheck(named(name), broken)).rejects.toThrow();
    }
    await runEntityDriverCheck(
      named('a duplicate primary key is refused, not a silent replace'),
      broken,
    );
  });

  test('a store claiming a capability it lacks is found out, never skipped', async () => {
    const claims: EntityDriverSubject = {
      open: () => defineDriver(toyStore()),
      capabilities: ['aggregate:countBy'],
      foreignKeys: false,
    };
    const countBy = named(
      'countBy groups the visible rows of one tenant, in value order, absent never zero',
    );
    await expect(runEntityDriverCheck(countBy, claims)).rejects.toThrow();
  });
});

/** How many times the check must ask for the waiter count before the contender's lock answers. */
const POLLS_BEFORE_CONTENDER = 20;

/**
 * A `lock` that never locks, whose CONTENDER is slow: the third lock call (after the outer c3 and
 * the nested c4) answers only once the check has asked `lockWaiters` `POLLS_BEFORE_CONTENDER`
 * times, or once the outer lock has ended. Sequenced on events, never a clock: a check that gave up
 * after any window or count of its own ends the outer first and passes this broken driver.
 */
const unlockedWithSlowContender = (): { driver: Driver; lockWaiters: () => number } => {
  const inner = memoryDriver();
  const contenderMayRun = Promise.withResolvers<void>();
  let polls = 0;
  let lockCalls = 0;
  const driver: Driver = {
    ...inner,
    repo: <Row>(entity: EntityCore<Row>): Repo<Row> => {
      const repo = inner.repo(entity);
      return {
        ...repo,
        lock: async (id, fn) => {
          lockCalls += 1;
          const call = lockCalls;
          if (call === 3) await contenderMayRun.promise;
          try {
            return await memoryTransactor().run(async (tx) => {
              const row = await repo.findById(id);
              return fn(row as Row, tx);
            });
          } finally {
            // The outer ending frees the contender too, so a check that stops polling early cannot
            // deadlock against this double: it simply passes it, and the test below goes red.
            if (call === 1) contenderMayRun.resolve();
          }
        },
      };
    },
  };
  const lockWaiters = (): number => {
    polls += 1;
    if (polls >= POLLS_BEFORE_CONTENDER) contenderMayRun.resolve();
    // Its lock never queues, so nothing ever waits — never the memory driver's process-wide count,
    // which another check in this file may have left non-zero.
    return 0;
  };
  return { driver, lockWaiters };
};

describe(testName('unit', 'a driver whose nested lock lets a slow contender through fails'), () => {
  test('the hold check waits on the contender, never on a clock', async () => {
    const broken = unlockedWithSlowContender();
    const subject: EntityDriverSubject = {
      open: () => broken.driver,
      capabilities: DRIVER_CAPABILITIES,
      foreignKeys: false,
      lockWaiters: broken.lockWaiters,
    };
    await expect(
      runEntityDriverCheck(
        named('a nested lock is held to the outer end, not released with its own'),
        subject,
      ),
    ).rejects.toThrow();
  }, 10_000);
});
