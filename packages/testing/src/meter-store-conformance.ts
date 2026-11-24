// The `MeterStore` contract of `@ultimat3/action` as shared examples, for a store of your own:
// `behavesLike(meterStoreConformance, () => store)`. The race is the point: a draw is one atomic
// check-and-add, and a store that reads then writes admits past the limit under parallel calls.

import { expect, test } from 'bun:test';
import type { MeterDrawResult, MeterKey, MeterStore } from '@ultimat3/action/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

export interface MeterStoreCheck {
  readonly name: string;
  run(store: MeterStore): Promise<void>;
}

const DAY = 86_400_000;
const START = Date.parse('2026-11-06T00:00:00.000Z');
const RACERS = 50;

let minted = 0;
/** A subject no other check, run or process shares — a shared database outlives one test file. */
const keyOf = (): MeterKey => {
  minted += 1;
  return {
    subject: `org:conformance-${process.pid.toString(36)}-${minted.toString(36)}`,
    meter: 'calls',
    period: 'day@UTC',
  };
};

const drawOf =
  (store: MeterStore, key: MeterKey) =>
  (limit: number, periodStartMs = START, over: Partial<MeterKey> = {}) =>
    store.draw({ ...key, ...over, periodStartMs, limit });

/** A draw of `amount` under `drawKey` — `drawMeter`'s shape at the port. */
const keyedOf =
  (store: MeterStore, key: MeterKey) =>
  (limit: number, amount: number, drawKey: string, periodStartMs = START) =>
    store.draw({ ...key, periodStartMs, limit, amount, drawKey });

/**
 * A draw's answer, judged on what the port requires: `replayed` must be `true` on a replay, and on
 * anything else may be `false` or absent; `periodStartMs`, when a store returns it, is checked by
 * the check that names it.
 */
function expectDraw(
  result: MeterDrawResult,
  expected: { allowed: boolean; used: number; warned: boolean; replayed?: true },
): void {
  expect({ allowed: result.allowed, used: result.used, warned: result.warned }).toEqual({
    allowed: expected.allowed,
    used: expected.used,
    warned: expected.warned,
  });
  if (expected.replayed === true) expect(result.replayed).toBe(true);
  else expect(result.replayed === undefined || result.replayed === false).toBe(true);
}

export const METER_STORE_CHECKS: readonly MeterStoreCheck[] = [
  {
    name: 'declares its scope',
    async run(store) {
      expect(['process', 'shared']).toContain(store.scope);
    },
  },
  {
    name: 'counts up to the limit and refuses the next draw without counting it',
    async run(store) {
      const draw = drawOf(store, keyOf());
      const seen = [];
      for (let i = 0; i < 4; i += 1) seen.push(await draw(3));
      expect(seen.map((result) => [result.allowed, result.used])).toEqual([
        [true, 1],
        [true, 2],
        [true, 3],
        [false, 3],
      ]);
    },
  },
  {
    name: `${RACERS} parallel draws at the edge admit exactly the limit`,
    async run(store) {
      const draw = drawOf(store, keyOf());
      const results = await Promise.all(Array.from({ length: RACERS }, () => draw(7)));
      expect(results.filter((result) => result.allowed)).toHaveLength(7);
      expect(results.filter((result) => !result.allowed).every((r) => r.used === 7)).toBe(true);
    },
  },
  {
    name: 'a limit of 0 refuses every draw',
    async run(store) {
      expect((await drawOf(store, keyOf())(0)).allowed).toBe(false);
    },
  },
  {
    name: 'a later period starts from zero; an earlier one adds to the current',
    async run(store) {
      const draw = drawOf(store, keyOf());
      await draw(2, START + DAY);
      await draw(2, START + DAY);
      expect((await draw(2, START + DAY)).allowed).toBe(false);
      // A replica a period behind cannot reset today's count by drawing against yesterday.
      expect((await draw(2, START)).allowed).toBe(false);
      expectDraw(await draw(2, START + 2 * DAY), { allowed: true, used: 1, warned: false });
    },
  },
  {
    name: 'a raised limit applies at once, to the count already spent',
    async run(store) {
      const draw = drawOf(store, keyOf());
      await draw(1);
      expect((await draw(1)).allowed).toBe(false);
      expectDraw(await draw(5), { allowed: true, used: 2, warned: false });
    },
  },
  {
    name: 'subjects, meters and period declarations are separate counters',
    async run(store) {
      const key = keyOf();
      const draw = drawOf(store, key);
      await draw(1);
      expect((await draw(1, START, { subject: `${key.subject}-2` })).allowed).toBe(true);
      expect((await draw(1, START, { meter: 'exports' })).allowed).toBe(true);
      expect((await draw(1, START, { period: 'month@UTC' })).allowed).toBe(true);
      expect((await draw(1)).allowed).toBe(false);
    },
  },
  {
    name: 'an amount counts whole, and one that would pass the limit counts nothing',
    async run(store) {
      const key = keyOf();
      const draw = (limit: number, amount: number) =>
        store.draw({ ...key, periodStartMs: START, limit, amount });
      expectDraw(await draw(10, 7), { allowed: true, used: 7, warned: false });
      expectDraw(await draw(10, 4), { allowed: false, used: 7, warned: false });
      expectDraw(await draw(10, 3), { allowed: true, used: 10, warned: false });
      expect((await draw(10, 1)).allowed).toBe(false);
    },
  },
  {
    name: `${RACERS} parallel draws under one key add it once`,
    async run(store) {
      const keyed = keyedOf(store, keyOf());
      const results = await Promise.all(Array.from({ length: RACERS }, () => keyed(100, 3, 'k1')));
      expect(results.every((result) => result.allowed)).toBe(true);
      expect(results.filter((result) => result.replayed !== true)).toHaveLength(1);
      expectDraw(await keyed(100, 3, 'k2'), { allowed: true, used: 6, warned: false });
      expectDraw(await keyed(100, 3, 'k1'), {
        allowed: true,
        used: 6,
        warned: false,
        replayed: true,
      });
    },
  },
  {
    name: 'a refused keyed draw leaves its key unspent, and a replay answers a spent allowance',
    async run(store) {
      const keyed = keyedOf(store, keyOf());
      expect((await keyed(5, 5, 'k1')).allowed).toBe(true);
      expectDraw(await keyed(5, 1, 'k2'), { allowed: false, used: 5, warned: false });
      expectDraw(await keyed(5, 5, 'k1'), {
        allowed: true,
        used: 5,
        warned: false,
        replayed: true,
      });
      expectDraw(await keyed(6, 1, 'k2'), { allowed: true, used: 6, warned: false });
    },
  },
  {
    name: 'a key is remembered into the next period and forgotten in the one after',
    async run(store) {
      const keyed = keyedOf(store, keyOf());
      await keyed(10, 4, 'k1');
      expectDraw(await keyed(10, 4, 'k1', START + DAY), {
        allowed: true,
        used: 0,
        warned: false,
        replayed: true,
      });
      expectDraw(await keyed(10, 2, 'k2', START + DAY), {
        allowed: true,
        used: 2,
        warned: false,
      });
      expectDraw(await keyed(10, 4, 'k1', START + 2 * DAY), {
        allowed: true,
        used: 4,
        warned: false,
      });
    },
  },
  {
    name: 'declares that it counts amounts and remembers draw keys',
    async run(store) {
      expect(store.keyedDraws).toBe(true);
    },
  },
  {
    name: 'a lagging keyed draw counts in the open period, and its key lasts as long as that period',
    async run(store) {
      const key = keyOf();
      const keyed = keyedOf(store, key);
      await drawOf(store, key)(100, START + DAY);
      const late = await keyed(100, 3, 'late', START);
      expectDraw(late, { allowed: true, used: 4, warned: false });
      if (late.periodStartMs !== undefined) expect(late.periodStartMs).toBe(START + DAY);
      // Charged on day two, so day three still remembers it: a retry adds nothing.
      expectDraw(await keyed(100, 3, 'late', START + 2 * DAY), {
        allowed: true,
        used: 0,
        warned: false,
        replayed: true,
      });
    },
  },
  {
    name: "a lagging retry of a key the counter's own period has forgotten is counted again",
    async run(store) {
      const key = keyOf();
      const keyed = keyedOf(store, key);
      await keyed(100, 3, 'k', START);
      await drawOf(store, key)(100, START + 2 * DAY);
      // The counter is on day three, which remembers day two's keys and no older ones.
      expectDraw(await keyed(100, 3, 'k', START + DAY), { allowed: true, used: 4, warned: false });
    },
  },
  {
    name: 'a refused draw of a later period forgets no key the open period still remembers',
    async run(store) {
      const key = keyOf();
      const keyed = keyedOf(store, key);
      await keyed(10, 1, 'k', START);
      await drawOf(store, key)(10, START + DAY);
      expect((await keyed(10, 11, 'too-big', START + 2 * DAY)).allowed).toBe(false);
      expectDraw(await keyed(10, 1, 'k', START + DAY), {
        allowed: true,
        used: 1,
        warned: false,
        replayed: true,
      });
    },
  },
  {
    name: 'a refused first draw leaves no counter a lagging draw could spend',
    async run(store) {
      const key = keyOf();
      const keyed = keyedOf(store, key);
      expect((await keyed(10, 11, 'too-big', START + DAY)).allowed).toBe(false);
      expectDraw(await keyed(10, 10, 'k', START), { allowed: true, used: 10, warned: false });
      // Day two never admitted a draw, so its allowance is whole.
      expectDraw(await drawOf(store, key)(10, START + DAY), {
        allowed: true,
        used: 1,
        warned: false,
      });
    },
  },
  {
    name: "a period's warning has one claimant, is released for a retry, and resets with the period",
    async run(store) {
      const key = keyOf();
      const draw = drawOf(store, key);
      await draw(9);
      const claims = await Promise.all(
        Array.from({ length: 6 }, () => store.claimWarning(key, START)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await draw(9)).warned).toBe(true);
      await store.releaseWarning(key, START);
      expect(await store.claimWarning(key, START)).toBe(true);
      // A claim for a period the counter is not in is no claim at all.
      expect(await store.claimWarning(key, START + DAY)).toBe(false);
      expect((await draw(9, START + DAY)).warned).toBe(false);
    },
  },
];

export const meterStoreConformance: SharedExamples<Maybe<MeterStore>> = sharedExamples(
  'a meter store',
  (subject) => {
    for (const check of METER_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  },
);
