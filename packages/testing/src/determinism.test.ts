import { describe, expect, test } from 'bun:test';
// `node:vm` is the only way to get a second realm in-process; Bun has no native equivalent, and a
// second realm is the whole point of the cross-realm test below.
import { runInNewContext } from 'node:vm';
import {
  advanceClock,
  assertDeterministic,
  captureDeterminism,
  frozenNow,
  installDeterminism,
  isDeterminismInstalled,
  onClockMoved,
  restoreCapturedDeterminism,
  seededRandom,
  seededUuid,
  setFrozenClock,
  withFrozenClock,
} from './determinism';

// Self-sufficient: the preload installs this globally, but a single test file must be runnable on
// its own with `bun test src/determinism.test.ts`.
installDeterminism();

describe('unit · determinism', () => {
  test('the clock is frozen: two reads of now() are identical', () => {
    setFrozenClock('2026-01-01T00:00:00.000Z');
    const first = Date.now();
    const second = Date.now();
    expect(first).toBe(second);
    expect(new Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('time only moves when a test advances it', () => {
    setFrozenClock('2026-01-01T00:00:00.000Z');
    advanceClock(3 * 24 * 60 * 60 * 1000);
    expect(frozenNow().toISOString()).toBe('2026-01-04T00:00:00.000Z');
  });

  test('withFrozenClock scopes the clock to one body and restores it', async () => {
    setFrozenClock('2026-01-01T00:00:00.000Z');
    const inside = await withFrozenClock('2030-06-01T12:00:00.000Z', () =>
      new Date().toISOString(),
    );
    expect(inside).toBe('2030-06-01T12:00:00.000Z');
    expect(new Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('an explicit Date argument still constructs the date it was given', () => {
    expect(new Date('1999-12-31T00:00:00.000Z').getUTCFullYear()).toBe(1999);
    expect(new Date(0).getTime()).toBe(0);
  });

  test('a Date the runtime built for itself is still a Date', () => {
    // The frozen clock replaces `globalThis.Date` with a subclass, so a plain `instanceof Date`
    // would ask "is it a FrozenDate" — and a value that never went through the patched
    // constructor is not one. That is every `timestamptz` Bun's Postgres driver decodes, which
    // made `@ultimat3/entity`'s column parser reject real rows under test and nowhere else.
    const native = structuredClone(new Date('2020-05-05T00:00:00.000Z'));
    expect(native instanceof Date).toBe(true);
    expect(new Date() instanceof Date).toBe(true);
    expect(frozenNow() instanceof Date).toBe(true);
    // Still a real predicate: it must not wave through something that is not a date at all.
    expect(({} as unknown) instanceof Date).toBe(false);
    // `unknown`, not a cast on the constructor: the LHS is a PRIMITIVE, which is what the
    // narrowing `instanceof` refuses, and a date-shaped string is the value most likely to be
    // waved through by a patched predicate that only looks at the text.
    const dateShapedString: unknown = '2020-05-05';
    expect(dateShapedString instanceof Date).toBe(false);
  });

  test('a Date built in another realm is still a Date', () => {
    // Prototype chains are per-realm: a Date built in a second realm inherits *that* realm's
    // `Date.prototype`, so testing it against this realm's constructor answers false however real
    // the value is. `node:vm` is the reachable case — the doc comment's "another realm" is this.
    const foreign: unknown = runInNewContext('new Date("2020-05-05T00:00:00.000Z")');
    expect(isDeterminismInstalled()).toBe(true);
    expect(foreign instanceof Date).toBe(true);
    // Guards the guard: if the vm ever shared intrinsics this would just be the test above again.
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.getPrototypeOf(new Date()));
  });

  test('an object that only claims to be a Date is not one', () => {
    // The cheap brand — `Object.prototype.toString` — is forgeable, and so is an own `getTime`.
    // The override reads the internal slot instead, which neither of them gives you.
    const spoof = { [Symbol.toStringTag]: 'Date', getTime: () => 0 };
    expect(Object.prototype.toString.call(spoof)).toBe('[object Date]');
    expect(spoof instanceof Date).toBe(false);
  });

  test('the seeded RNG produces the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const first = [a(), a(), a()];
    expect(first).toEqual([b(), b(), b()]);
    expect(first[0]).not.toBe(c());
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('seeded uuids are stable and well-formed', () => {
    const uuid = seededUuid(7);
    const value = uuid();
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seededUuid(7)()).toBe(value);
  });

  // The pair a nested scope must use. `restoreDeterminism()` uninstalls, which in a process the
  // preload installed once is not a restore at all — it is the real clock and the real
  // `Math.random` handed to every later test FILE in the run.
  test('capture/restore puts back the instant and the generator, not the defaults', () => {
    // The outermost snapshot is this test taking its own advice: the file shares a process with
    // every file after it, so the clock it borrows goes back where it was.
    const outermost = captureDeterminism();
    try {
      setFrozenClock('2026-03-03T00:00:00.000Z');
      const snapshot = captureDeterminism();
      const outerSequence = [Math.random(), Math.random()];

      installDeterminism({ seed: 4242, now: '2031-09-09T00:00:00.000Z' });
      expect(new Date().toISOString()).toBe('2031-09-09T00:00:00.000Z');
      expect(Math.random()).toBe(seededRandom(4242)());

      restoreCapturedDeterminism(snapshot);
      expect(isDeterminismInstalled()).toBe(true);
      expect(new Date().toISOString()).toBe('2026-03-03T00:00:00.000Z');
      // By identity, so the outer generator resumes where it was rather than restarting: an equal
      // sequence from a re-seeded copy would make two nested scopes draw the same "random" values.
      expect(Math.random).toBe(snapshot.random);
      expect([Math.random(), Math.random()]).not.toEqual(outerSequence);
    } finally {
      restoreCapturedDeterminism(outermost);
    }
  });

  test('assertDeterministic fails a body that changes between runs', async () => {
    let counter = 0;
    expect(await assertDeterministic('stable', () => 'same')).toBe('same');
    try {
      await assertDeterministic('counter', () => {
        counter += 1;
        return counter;
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_NONDETERMINISTIC');
      expect((error as { fix: string }).fix).toBe(
        "assertDeterministic('…', () => { installDeterminism(); return body(); })",
      );
    }
  });

  test('withFrozenClock announces its move in, and its move back out', async () => {
    // The frozen scheduler renews leases on `onClockMoved`: a jump it never hears is a lease that
    // never renews inside the body, and a restore it never hears leaves its timers on the body's time.
    setFrozenClock('2026-01-01T00:00:00.000Z');
    const heard: string[] = [];
    const stop = onClockMoved(() => heard.push(frozenNow().toISOString()));
    try {
      await withFrozenClock('2030-06-01T00:00:00.000Z', () => undefined);
    } finally {
      stop();
    }
    expect(heard).toEqual(['2030-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });

  test('assertDeterministic compares a BigInt result, and a cyclic one, with no bare TypeError', async () => {
    expect(await assertDeterministic('bigint', () => ({ n: 10n }))).toEqual({ n: 10n });
    const cyclic = (): Record<string, unknown> => {
      const node: Record<string, unknown> = { id: 1 };
      node['self'] = node;
      return node;
    };
    expect((await assertDeterministic('cyclic', cyclic))['id']).toBe(1);
    let calls = 0n;
    const drifting = assertDeterministic('drifting bigint', () => {
      calls += 1n;
      return calls;
    });
    await expect(drifting).rejects.toBeUltimateError('X_TEST_NONDETERMINISTIC');
    let id = 0;
    const cyclicDrift = assertDeterministic('drifting cycle', () => {
      id += 1;
      const node: Record<string, unknown> = { id };
      node['self'] = node;
      return node;
    });
    await expect(cyclicDrift).rejects.toBeUltimateError('X_TEST_NONDETERMINISTIC');
  });

  test('assertDeterministic reads key order as no difference', async () => {
    let flip = false;
    const result = await assertDeterministic('key order', () => {
      flip = !flip;
      return flip ? { a: 1, b: 2 } : { b: 2, a: 1 };
    });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test('a listener that throws on entry still gets the outer instant back, body unrun', async () => {
    setFrozenClock('2026-01-01T00:00:00.000Z');
    let calls = 0;
    const stop = onClockMoved(() => {
      calls += 1;
      if (calls === 1) throw new TypeError('listener refused the move');
    });
    let ran = false;
    try {
      await expect(
        withFrozenClock('2030-06-01T00:00:00.000Z', () => {
          ran = true;
        }),
      ).rejects.toThrow('listener refused the move');
    } finally {
      stop();
    }
    expect(ran).toBe(false);
    expect(frozenNow().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('assertDeterministic tells undefined, null, a function and a symbol apart', async () => {
    const results: unknown[][] = [
      [undefined, null],
      [null, undefined],
      [() => 1, null],
      [Symbol('s'), undefined],
    ];
    for (const [first, second] of results) {
      let flip = false;
      const drift = assertDeterministic('top-level token', () => {
        flip = !flip;
        return flip ? first : second;
      });
      await expect(drift).rejects.toBeUltimateError('X_TEST_NONDETERMINISTIC');
    }
    expect(await assertDeterministic('undefined twice', () => undefined)).toBeUndefined();
  });

  test('the fix X_TEST_NONDETERMINISTIC hands out makes a clock-and-random body pass', async () => {
    const snapshot = captureDeterminism();
    const body = (): readonly number[] => [Date.now(), Math.random(), advanceClock(1).getTime()];
    try {
      const error = await assertDeterministic('bare', body).catch((caught: unknown) => caught);
      expect(error).toBeUltimateError('X_TEST_NONDETERMINISTIC');
      expect((error as { fix: string }).fix).toBe(
        "assertDeterministic('…', () => { installDeterminism(); return body(); })",
      );
      // The fix, verbatim in shape: re-install the seeded clock and RNG before each run.
      const result = await assertDeterministic('fixed', () => {
        installDeterminism();
        return body();
      });
      expect(result).toHaveLength(3);
    } finally {
      restoreCapturedDeterminism(snapshot);
    }
  });
});
