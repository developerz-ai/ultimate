// The two numbers one attempt reads off the DEFINITION, when they are not numbers.
//
// `scrape()` already refuses a non-finite `rate` where it is written, which is the right distance
// and is not the whole story: `runScrape` is exported, so a definition assembled by hand — a
// replay harness, a second wrapper, a test — never passes through that assert. The layered form
// this repo already uses for `backfill()`/`inBatches()`: refuse it where it is written AND where
// it is read.
//
// `pageTimeout` has no assert at either distance today. It becomes the run's page timeout, which
// is handed to the robots gate's read deadline, to every driver's `timeoutMs` and to every
// actionability budget under it — so one non-finite declaration turns robots enforcement off and
// makes every wait unbounded, in a run that reports nothing about either.

import { describe, expect, test } from 'bun:test';
import { createContext, createLogger, isUltimateError, renderThrowable } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { testClock } from './clock';
import { fakeBrowser } from './driver-fake';
import type { ScrapeDefinition } from './scrape';
import { runScrape } from './scrape-run';

const URL_A = 'https://shop.test/orders';
const HTML = '<html><body><ul><li class="row" data-id="1">One</li></ul></body></html>';

const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

const passThroughStep = (): StepApi =>
  ({
    run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  }) as unknown as StepApi;

const runArgs = (): JobRunArgs<{ page: number }> => ({
  input: { page: 1 },
  step: passThroughStep(),
  ctx: createContext({ logger: createLogger({ writer: () => undefined }) }),
  attempt: 1,
  jobId: 'job-1',
  runId: 'run-1',
});

const define = (
  over: Partial<ScrapeDefinition<{ page: number }, { id: string }>> = {},
): ScrapeDefinition<{ page: number }, { id: string }> => ({
  name: 'orders',
  input: t.object({ page: t.number }),
  extract: t.object({ id: t.string }),
  idempotencyKey: (input) => `orders:${String(input.page)}`,
  tenant: 'none',
  allowHosts: ['shop.test'],
  clock: testClock(),
  driver: fakeBrowser([{ url: URL_A, html: HTML }]),
  // Declared so no test here fires the default `/robots.txt` read at a host it does not own.
  robots: { ignore: 'the fixture site is this suite' },
  async run({ page }) {
    await page.goto(URL_A);
    return (await page.values('.row')).map((element) => ({ id: element.attrs['data-id'] }));
  },
  ...over,
});

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; cause: string }> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a definition bound that is not a number was accepted');
}

describe('unit · one attempt, bounded', () => {
  for (const value of NOT_A_BOUND) {
    test(`a rate of ${String(value)} is refused by the attempt, not just by scrape()`, async () => {
      const error = await refusal(() => runScrape(define({ rate: value }), runArgs()));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('rate');
    });

    test(`a pageTimeout of ${String(value)} is refused before the browser opens`, async () => {
      const error = await refusal(() => runScrape(define({ pageTimeout: value }), runArgs()));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('pageTimeout');
    });
  }

  // A zero page timeout is a wait budget of nothing on every operation of the run: every
  // `waitFor` gets one look and every navigation is already out of time. The floor is 1.
  test('a pageTimeout of 0 is refused', async () => {
    const error = await refusal(() => runScrape(define({ pageTimeout: 0 }), runArgs()));
    expect(error.cause).toContain('pageTimeout');
  });

  test('the durations a definition actually declares still run', async () => {
    const report = await runScrape(define({ pageTimeout: '15s', rate: 50 }), runArgs());
    expect(report.rows).toEqual([{ id: '1' }]);
  });
});
