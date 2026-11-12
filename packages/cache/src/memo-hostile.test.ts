// A value the memo cannot measure is still memoized and never escapes as an error: the charge
// runs in a promise's `.then` (an unhandled rejection exits the process) or inline on a sync
// `memoPerRequest` call (a throw would fail a read that had already succeeded).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, UltimateError } from '@ultimat3/core';
import { memoFlights } from './memo-flights';
import { memoPerRequest } from './memo-per-request';

/** The hostile read: coded, so the throw is this test's INPUT and never a bare verdict. */
const refusal = (what: string): UltimateError =>
  new UltimateError({
    code: 'X_INTERNAL',
    cause: `${what} refuses, standing in for a hostile value a query returned`,
    fix: 'bun test ./packages/cache/src/memo-hostile.test.ts',
  });

const throwingGetter = (): object =>
  Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      throw refusal('the getter');
    },
  });
const throwingProxy = (): object =>
  new Proxy(
    {},
    {
      ownKeys() {
        throw refusal('ownKeys');
      },
    },
  );

let unhandled: unknown[] = [];
const record = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', record);
});
afterEach(() => {
  process.off('unhandledRejection', record);
});

/** Long enough for a `.then` handler's rejection to be reported as unhandled. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('the memo charge never escapes', () => {
  for (const [shape, make] of [
    ['a throwing getter', throwingGetter],
    ['a Proxy whose ownKeys throws', throwingProxy],
  ] as const) {
    test(`memoFlights.publish of ${shape}: held, no unhandled rejection`, async () => {
      const value = make();
      const flights = memoFlights({}, 'q');
      flights.publish('k', Promise.resolve(value));
      await settle();
      expect(unhandled).toEqual([]);
      expect(await flights.get('k')).toBe(value);
    });

    test(`memoPerRequest returning ${shape} synchronously: returned, memoized`, async () => {
      let calls = 0;
      const value = make();
      const load = memoPerRequest(
        () => {
          calls += 1;
          return value;
        },
        () => 'k',
      );
      await runWithContext(ctxOf(), async () => {
        expect(load()).toBe(value);
        expect(load()).toBe(value);
      });
      expect(calls).toBe(1);
    });
  }
});
