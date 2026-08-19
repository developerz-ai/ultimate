/**
 * The pool's own contract, tested without a model in the way: three arms, split order, and the
 * rule both of them depend on — a member's throw is RECORDED, whatever it is. A member is an
 * app's action, so the thrown value is one the framework did not build, and a probe that raises
 * while reading it takes down the whole run the three arms exist to keep.
 */

import { describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { runPool } from './hive-pool';
import type { HiveMember } from './hive-result';
import { SKIPPED_ABORTED, SKIPPED_NO_INPUT } from './hive-result';

/** `withChildContext` needs an ambient one, so every pool here runs inside a real context. */
function pooled<I, O>(
  inputs: readonly I[],
  onMemberError: 'abort' | 'collect',
  member: (payload: I, ctx: Ctx) => Promise<O>,
): Promise<readonly HiveMember<O>[]> {
  const ctx = createContext({ actor: userActor({ id: 'user-7' }) });
  return runWithContext(ctx, () =>
    runPool<I, O>({
      inputs,
      width: 1,
      ctx,
      onMemberError,
      member: (payload) => member(payload, ctx),
    }),
  );
}

/** A value that fights every probe a `catch` block would make of it. */
const trapped = (): unknown =>
  new Proxy(
    {},
    {
      get() {
        throw new Error('trapped get');
      },
      getPrototypeOf() {
        throw new Error('trapped getPrototypeOf');
      },
    },
  );

describe('a member throw is recorded, never re-raised', () => {
  test.each([
    ['a Proxy that traps getPrototypeOf', trapped],
    ['a null-prototype object', () => Object.create(null) as unknown],
    ['a symbol', () => Symbol('thrown')],
    [
      'an object whose message getter throws',
      () =>
        Object.defineProperty({}, 'message', {
          get() {
            throw new Error('trapped message');
          },
          enumerable: true,
        }) as unknown,
    ],
  ])('%s becomes a failed member, and the siblings still run', async (_label, make) => {
    const members = await pooled<number, string>([1, 2, 3], 'collect', (payload) =>
      payload === 2 ? Promise.reject(make()) : Promise.resolve(`v${payload}`),
    );

    expect(members.map((one) => one.status)).toEqual(['ok', 'failed', 'ok']);
    const failed = members[1];
    expect(failed?.status === 'failed' ? failed.code : '').toBe('unknown');
    expect(failed?.status === 'failed' ? typeof failed.reason : '').toBe('string');
  });

  test('an ordinary Error keeps its own message', async () => {
    const members = await pooled<number, string>([1], 'collect', () =>
      Promise.reject(new Error('kaboom')),
    );
    expect(members[0]).toEqual({ status: 'failed', index: 0, code: 'unknown', reason: 'kaboom' });
  });
});

describe('a skipped member says WHICH skip it was', () => {
  test('an aborted sibling and an empty split are two different reasons', async () => {
    const stopped = await pooled<number, string>([1, 2, 3], 'abort', (payload) =>
      payload === 1 ? Promise.reject(new Error('no')) : Promise.resolve('v'),
    );
    expect(stopped.map((one) => (one.status === 'skipped' ? one.reason : one.status))).toEqual([
      'failed',
      SKIPPED_ABORTED,
      SKIPPED_ABORTED,
    ]);

    // Nothing was aborted here: index 1 simply has no input, and saying a sibling failed would
    // send a caller to retry a tail that was never cut.
    const sparse = await pooled<number | undefined, string>(
      [1, undefined, 3],
      'collect',
      (payload) => Promise.resolve(`v${payload}`),
    );
    expect(sparse.map((one) => (one.status === 'skipped' ? one.reason : one.status))).toEqual([
      'ok',
      SKIPPED_NO_INPUT,
      'ok',
    ]);
  });
});
