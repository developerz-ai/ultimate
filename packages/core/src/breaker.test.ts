// `breaker()`'s state machine on a fake monotonic clock: the transition table, one probe under
// concurrent `admit()`, a lapsed probe re-admitted, the probe settled only through its own ticket
// (a call from before the trip can neither close nor free it), non-finite bounds, and `run`.

import { afterEach, describe, expect, test } from 'bun:test';
import { breaker, defaultBreakerClassify } from './breaker';
import { isUltimateError, UltimateError } from './errors';
import { collectMetrics, resetMetrics } from './metrics';

afterEach(() => resetMetrics());

function fakeClock(): { monotonic: () => number; advance: (ms: number) => void } {
  let at = 1_000;
  return {
    monotonic: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

const coded = (code: string): UltimateError => new UltimateError({ code, cause: 'c', fix: 'f' });

const make = (clock = fakeClock()) => ({
  clock,
  gate: breaker({ name: 'vendor', failures: 3, cooldownMs: 10_000, clock }),
});

/** Opened by three failures, then advanced past the cooldown: the next admit is the probe. */
function halfOpen() {
  const made = make();
  for (let n = 0; n < 3; n += 1) made.gate.failed(made.gate.admit());
  made.clock.advance(10_000);
  return made;
}

describe('unit · breaker · transitions', () => {
  test('closed admits; the third consecutive failure opens it', () => {
    const { gate } = make();
    expect(gate.state()).toBe('closed');
    gate.failed(gate.admit());
    gate.failed(gate.admit());
    expect([gate.state(), gate.admit() !== undefined, gate.failures()]).toEqual([
      'closed',
      true,
      2,
    ]);
    gate.failed(gate.admit());
    expect([gate.state(), gate.admit()]).toEqual(['open', undefined]);
  });

  test('a success zeroes the run: two failures, a success, two failures stays closed', () => {
    const { gate } = make();
    for (const step of ['f', 'f', 's', 'f', 'f'] as const) {
      const ticket = gate.admit();
      if (step === 'f') gate.failed(ticket);
      else gate.succeeded(ticket);
    }
    expect([gate.state(), gate.failures()]).toEqual(['closed', 2]);
  });

  test('past the cooldown exactly one concurrent admit is the probe', () => {
    const { gate } = halfOpen();
    expect(gate.state()).toBe('half-open');
    const admitted = Array.from({ length: 5 }, () => gate.admit()?.probe);
    expect(admitted).toEqual([true, undefined, undefined, undefined, undefined]);
  });

  test("the probe's own success closes it; its failure reopens it at once", () => {
    const { gate, clock } = halfOpen();
    gate.failed(gate.admit());
    expect([gate.state(), gate.admit()]).toEqual(['open', undefined]);
    clock.advance(10_000);
    gate.succeeded(gate.admit());
    expect([gate.state(), gate.failures(), gate.admit()?.probe]).toEqual(['closed', 0, false]);
  });

  test('a late success from a call admitted before the trip never closes an open breaker', () => {
    const { gate } = make();
    const early = gate.admit();
    for (let n = 0; n < 3; n += 1) gate.failed(gate.admit());
    gate.succeeded(early);
    expect(gate.state()).toBe('open');
  });

  test("in half-open only the probe's ticket closes it or gives it back", () => {
    const { gate, clock } = make();
    const early = gate.admit();
    for (let n = 0; n < 3; n += 1) gate.failed(gate.admit());
    clock.advance(10_000);
    const probe = gate.admit();
    gate.released(early);
    expect(gate.admit()).toBeUndefined();
    gate.succeeded(early);
    expect(gate.state()).toBe('half-open');
    gate.succeeded(probe);
    expect(gate.state()).toBe('closed');
  });

  test('a probe that never settles lapses after the cooldown, so a dead holder cannot wedge it', () => {
    const { gate, clock } = halfOpen();
    expect(gate.admit()?.probe).toBe(true);
    clock.advance(9_999);
    expect(gate.admit()).toBeUndefined();
    clock.advance(1);
    expect(gate.admit()?.probe).toBe(true);
  });

  test('released() gives the probe back and counts nothing; state() consumes nothing', () => {
    const { gate } = halfOpen();
    for (let n = 0; n < 4; n += 1) expect(gate.state()).toBe('half-open');
    gate.released(gate.admit());
    expect(gate.failures()).toBe(3);
    expect(gate.admit()?.probe).toBe(true);
  });

  test('every state change is one breaker_transitions_total point', () => {
    const { gate } = halfOpen();
    gate.succeeded(gate.admit());
    const points =
      collectMetrics().metrics.find(
        (metric) => metric.descriptor.name === 'breaker_transitions_total',
      )?.points ?? [];
    const entered = points.map((point) => [
      point.attributes['name'],
      point.attributes['to'],
      point.value,
    ]);
    expect(entered.sort()).toEqual([
      ['vendor', 'closed', 1],
      ['vendor', 'half-open', 1],
      ['vendor', 'open', 1],
    ]);
  });

  test('a non-finite or fractional bound is refused at construction', () => {
    for (const bad of [Number.NaN, 2.5, 0]) {
      expect(() => breaker({ name: 'n', failures: bad, cooldownMs: 1 })).toThrow(/failures/);
      expect(() => breaker({ name: 'n', failures: 1, cooldownMs: bad })).toThrow(/cooldownMs/);
    }
  });
});

describe('unit · breaker · run', () => {
  test('a retryable code is a failure, an abort is ignored, any other outcome is an answer', () => {
    expect(defaultBreakerClassify(coded('X_TIMEOUT'))).toBe('failure');
    expect(defaultBreakerClassify(coded('X_FLIGHT_GATE_OVERLOADED'))).toBe('failure');
    expect(defaultBreakerClassify(coded('X_DRAINING'))).toBe('ignore');
    expect(defaultBreakerClassify(coded('X_ABORTED'))).toBe('ignore');
    expect(defaultBreakerClassify(coded('X_OUTBOUND_REFUSED'))).toBe('success');
    expect(defaultBreakerClassify(new TypeError('x'))).toBe('success');
  });

  test('run refuses X_BREAKER_OPEN while open, naming the time left', async () => {
    const { gate, clock } = make();
    for (let n = 0; n < 3; n += 1) {
      await gate.run(() => Promise.reject(coded('X_TIMEOUT'))).catch(() => undefined);
    }
    clock.advance(2_500);
    let calls = 0;
    try {
      await gate.run(async () => {
        calls += 1;
      });
      expect.unreachable('an open breaker ran the call');
    } catch (error) {
      if (!isUltimateError(error)) throw error;
      expect(error.code).toBe('X_BREAKER_OPEN');
      expect(error.retry).toBe('retry-after');
      expect(error.meta).toEqual({ name: 'vendor', retryAfterSeconds: 8 });
    }
    expect(calls).toBe(0);
  });

  test("run records a refusal as an answer, and a breaker's own classify wins", async () => {
    const own = breaker({
      name: 'own',
      failures: 1,
      cooldownMs: 10,
      clock: fakeClock(),
      classify: () => 'failure',
    });
    await own.run(() => Promise.reject(coded('X_OUTBOUND_REFUSED'))).catch(() => undefined);
    expect(own.state()).toBe('open');
    const { gate } = make();
    await gate.run(() => Promise.reject(coded('X_OUTBOUND_REFUSED'))).catch(() => undefined);
    await gate.run(() => Promise.reject(coded('X_DRAINING'))).catch(() => undefined);
    expect([gate.state(), gate.failures()]).toEqual(['closed', 0]);
    expect(await gate.run(async () => 7)).toBe(7);
  });
});
