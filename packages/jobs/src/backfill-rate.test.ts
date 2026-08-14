// The pacer on its own: what it ASKS for between batches, what the batch's own time buys back, and
// that a cancelled attempt leaves the wait immediately instead of holding a timer it no longer owns.
// The sleeper is injected in most of these, so the pacing is asserted rather than spent — the two
// that keep the real one are there because "does not sit in the timer" cannot be faked.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { DEFAULT_BACKFILL_BATCH } from './backfill';
import { createPacer, DEFAULT_BACKFILL_RATE } from './backfill-rate';

const NEVER_ABORTED = new AbortController().signal;

interface Paced {
  /** Every wait, in ms, in the order it was asked for. Waits skipped as too short never appear. */
  readonly asked: readonly number[];
  /** Time the batch itself took, charged against the interval like a real page would be. */
  batchTook(ms: number): void;
  wait(signal?: AbortSignal, step?: string): Promise<void>;
}

/** A pacer whose sleep is bookkeeping: the frozen clock moves by exactly what was asked for. */
const paced = (rate: number): Paced => {
  const clock = frozenClock('2026-08-14T00:00:00.000Z');
  const asked: number[] = [];
  const pacer = createPacer({
    rate,
    job: 'rewrite-titles',
    clock,
    sleep: (ms) => {
      asked.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  return {
    asked,
    batchTook: (ms) => clock.advance(ms),
    wait: (signal = NEVER_ABORTED, step) =>
      pacer.wait({ signal, ...(step === undefined ? {} : { step }) }),
  };
};

describe('the interval', () => {
  test('lets the first batch through and holds every one after it to the declared rate', async () => {
    const pacer = paced(5);

    await pacer.wait();
    await pacer.wait();
    await pacer.wait();

    // Five batches a second is one every 200ms — and nothing before the first, which has no
    // previous batch to be spaced from.
    expect(pacer.asked).toEqual([200, 200]);
  });

  test('charges the batch its own time, so only a fast page is held back', async () => {
    const pacer = paced(5);
    await pacer.wait();

    pacer.batchTook(150);
    await pacer.wait();

    expect(pacer.asked).toEqual([50]);
  });

  test('a batch slower than the interval waits for nothing at all', async () => {
    const pacer = paced(5);
    await pacer.wait();

    pacer.batchTook(500);
    await pacer.wait();
    pacer.batchTook(200);
    await pacer.wait();

    // Overshoot is not banked either: the next batch starts from where this one ended.
    expect(pacer.asked).toEqual([]);
  });

  test('a rate faster than a timer can resolve degenerates to no wait, not a slower sweep', async () => {
    // The documented escape hatch, and the only one: to sweep faster you raise `rate`. At 100k
    // batches/sec the remaining 0.01ms has no timer, and waiting a whole one for it would leave
    // the pass slower than it asked to be.
    const pacer = paced(100_000);

    await pacer.wait();
    await pacer.wait();
    await pacer.wait();

    expect(pacer.asked).toEqual([]);
  });

  test('a fractional rate is a rate: one batch every two seconds', async () => {
    const pacer = paced(0.5);

    await pacer.wait();
    await pacer.wait();

    expect(pacer.asked).toEqual([2000]);
  });
});

describe('cancellation', () => {
  test('refuses to start a wait for an attempt that no longer owns the run', async () => {
    const pacer = paced(5);
    await pacer.wait();
    const cancelled = AbortSignal.abort();

    const thrown = await pacer.wait(cancelled, 'batch:1').catch((error: unknown) => error);

    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_ABORTED');
    expect(isUltimateError(thrown) ? thrown.cause : '').toContain('batch:1');
    // Never entered: a cancelled attempt must not spend 200ms finding out it was cancelled.
    expect(pacer.asked).toEqual([]);
  });

  test('an abort DURING the wait rejects instead of resuming the pass', async () => {
    const clock = frozenClock('2026-08-14T00:00:00.000Z');
    const controller = new AbortController();
    const pacer = createPacer({
      rate: 5,
      job: 'rewrite-titles',
      clock,
      // What a real sleeper does when the signal fires: settle early, having waited part of it.
      sleep: (ms, signal) => {
        clock.advance(ms / 2);
        controller.abort();
        expect(signal.aborted).toBe(true);
        return Promise.resolve();
      },
    });
    await pacer.wait({ signal: controller.signal });

    const thrown = await pacer
      .wait({ signal: controller.signal, step: 'batch:1' })
      .catch((error: unknown) => error);

    // The sleeper resolving means "the wait is over", never "the slot arrived": read another page
    // here and the attempt that replaced this one gets the write.
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_ABORTED');
  });

  test('the real sleeper wakes on abort instead of sitting the interval out', async () => {
    // Real timers on purpose — this is the one claim an injected sleeper cannot make. One batch
    // every two seconds, cancelled 5ms in: the wait has to end with the attempt, not with the slot.
    const pacer = createPacer({ rate: 0.5, job: 'rewrite-titles' });
    const controller = new AbortController();
    await pacer.wait({ signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    const startedAt = performance.now();
    const thrown = await pacer
      .wait({ signal: controller.signal, step: 'batch:1' })
      .catch((error: unknown) => error);
    const elapsed = performance.now() - startedAt;

    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_ABORTED');
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('the default', () => {
  test('is a background sweep and not a load test', async () => {
    // The number in the doc comment, in the unit an operator cares about. Raising it is allowed;
    // raising it past a sweep that leaves the pool to the app is a decision, not a tweak.
    expect(DEFAULT_BACKFILL_RATE * DEFAULT_BACKFILL_BATCH).toBeLessThanOrEqual(10_000);
    expect(DEFAULT_BACKFILL_RATE).toBeGreaterThan(0);

    const pacer = paced(DEFAULT_BACKFILL_RATE);
    await pacer.wait();
    await pacer.wait();

    expect(pacer.asked).toEqual([1000 / DEFAULT_BACKFILL_RATE]);
  });
});
