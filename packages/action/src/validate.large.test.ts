// A hostile body at the action seam: 10,000 invalid items must cost a bounded refusal — at most
// `MAX_ISSUES` issues, the list marked a prefix, the rendered line bounded — and answer quickly,
// on the way in and on the way out. Every surface shares this parse, so this is every surface.

import { describe, expect, test } from 'bun:test';
import { MAX_ISSUES, t } from '@ultimat3/schema';
import { InputInvalidError, OutputInvalidError } from './errors';
import { parseActionInput, validateOutput } from './validate';

const Items = t.object({ items: t.array(t.object({ price: t.number })) });

const hostile = (length: number): unknown => ({
  items: Array.from({ length }, () => ({ price: 'not a number' })),
});

const HOSTILE = hostile(10_000);

/** `OutputInvalidError` keeps the line alone, cut at 4 KiB, so the cap shows only as cost: 50k. */
const HOSTILE_OUTPUT = hostile(50_000);

/**
 * Generous against a loaded CI runner. Measured 2026-11-09: capped ~2 ms either way; uncapped,
 * 10k issues ~70 ms and 50k ~500 ms.
 */
const BUDGET_MS = 100;

describe('a hostile invalid payload', () => {
  test('input, 10k items: at most MAX_ISSUES issues, marked truncated, quickly', async () => {
    const started = performance.now();
    const failure = await parseActionInput(Items, HOSTILE, 'importPrices').catch(
      (error: unknown) => error,
    );
    const elapsed = performance.now() - started;
    if (!(failure instanceof InputInvalidError)) {
      return expect.unreachable('expected an InputInvalidError');
    }
    expect(failure.issues?.length).toBeLessThanOrEqual(MAX_ISSUES);
    expect(failure.issuesTruncated).toBe(true);
    expect(failure.cause.length).toBeLessThanOrEqual(4096);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  test('output, 50k items: the drifted answer is refused with a bounded line, quickly', async () => {
    const started = performance.now();
    const failure = await validateOutput(Items, HOSTILE_OUTPUT, 'importPrices').catch(
      (error: unknown) => error,
    );
    const elapsed = performance.now() - started;
    if (!(failure instanceof OutputInvalidError)) {
      return expect.unreachable('expected an OutputInvalidError');
    }
    expect(failure.cause.length).toBeLessThanOrEqual(4096);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
