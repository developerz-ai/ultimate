// `lockKeys` on the memory driver and its two shared halves: the inputs (`lockKey`'s spelling,
// deduped, sorted, bounded) and the nesting that holds them in one transaction. The Postgres twin
// is `lock-keys.live.test.ts`.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { holdInOrder, lockKeyInput, lockKeysInput, MAX_LOCK_KEYS } from './lock-key';
import { memoryRepo } from './memory-repo';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

afterAll(() => {
  clearRegistry();
});

const accounts = entity('lock_keys_accounts', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), label: text({ max: 10 }) },
});
const ORG = '00000000-0000-7000-8000-00000000000a';
const inOrg = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u', orgId: ORG }) }), work);

// One event-loop turn: every microtask the memory lock chains settles before it, so a waiter that
// could run has run by then — "still parked" is then an observation, not a guess at a duration.
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'did not throw';
};

describe('unit · lockKeysInput', () => {
  test("each key as lockKey spells it, deduped and sorted whatever the caller's order", async () => {
    await inOrg(async () => {
      const inputs = lockKeysInput(accounts, ['b', 'a', 'b'], undefined);
      expect(inputs).toEqual([
        lockKeyInput(accounts, 'a', undefined),
        lockKeyInput(accounts, 'b', undefined),
      ]);
      expect(lockKeysInput(accounts, ['a', 'b'], undefined)).toEqual(inputs);
      expect(inputs[0]).toContain(ORG);
    });
  });

  test('no key, a blank key and more than the lock table holds are refused', async () => {
    await inOrg(async () => {
      expect(codeOf(() => lockKeysInput(accounts, [], undefined))).toBe('X_INVARIANT');
      expect(codeOf(() => lockKeysInput(accounts, ['a', ' '], undefined))).toBe('X_INVARIANT');
      const many = Array.from({ length: MAX_LOCK_KEYS + 1 }, (_, at) => `k${at}`);
      expect(codeOf(() => lockKeysInput(accounts, many, undefined))).toBe('X_INVARIANT');
      expect(lockKeysInput(accounts, many.slice(1), undefined)).toHaveLength(MAX_LOCK_KEYS);
    });
  });

  test('a tenant-scoped entity with no actor is refused as lockKey is', () => {
    expect(codeOf(() => lockKeysInput(accounts, ['a'], undefined))).toBe('X_TENANCY_UNSCOPED');
  });
});

describe('unit · holdInOrder', () => {
  test('takes each input inside the last, in order, and hands fn the innermost tx', async () => {
    const taken: string[] = [];
    const answer = await holdInOrder<string, string>(
      ['a', 'b', 'c'],
      async (input, outer, body) => {
        taken.push(`${input}<${outer ?? 'root'}`);
        return body(`tx-${input}`);
      },
      (tx) => `fn in ${tx}`,
    );
    expect(taken).toEqual(['a<root', 'b<tx-a', 'c<tx-b']);
    expect(answer).toBe('fn in tx-c');
  });
});

describe('unit · memory · lockKeys', () => {
  const db = () => database({ accounts }, { driver: memoryDriver() });

  test('holds every key: a lockKey on any of them waits for the whole fn', async () => {
    const handle = db();
    await inOrg(async () => {
      const order: string[] = [];
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const held = handle.accounts.lockKeys(['from', 'to'], async () => {
        entered.resolve();
        await release.promise;
        order.push('transfer');
      });
      await entered.promise;
      const waiter = handle.accounts.lockKey('to', () => {
        order.push('to');
      });
      await turn();
      expect(order).toEqual([]);
      release.resolve();
      await Promise.all([held, waiter]);
      expect(order).toEqual(['transfer', 'to']);
    });
  });

  test('two callers naming the same keys in opposite orders both finish', async () => {
    const handle = db();
    await inOrg(async () => {
      const done = await Promise.all([
        handle.accounts.lockKeys(['x', 'y'], async () => {
          await turn();
          return 'xy';
        }),
        handle.accounts.lockKeys(['y', 'x'], async () => {
          await turn();
          return 'yx';
        }),
      ]);
      expect(done).toEqual(['xy', 'yx']);
    });
  });

  test("fn's answer is the answer, and a hand-written Repo without it is X_LOCK_UNSUPPORTED", async () => {
    await inOrg(async () => {
      expect(await db().accounts.lockKeys(['k'], () => 42)).toBe(42);
    });
    const { lockKeys: _keys, ...bare } = memoryRepo(accounts);
    const table = tableFor(accounts, bare as Repo<typeof accounts.$row>);
    const refused = await table.lockKeys(['k'], () => 1).catch((error: unknown) => error);
    if (!isUltimateError(refused)) expect.unreachable('refused');
    expect(refused.code).toBe('X_LOCK_UNSUPPORTED');
  });
});
