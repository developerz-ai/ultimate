// `crashProof` on a sweep: one step per row. The proof kills at each distinct boundary — a loop's
// steps, named by row id, are one point killed at its first and last row — so the runs it costs
// are O(steps the code has), never O(rows the database holds). Past its bound it refuses by code.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JobHandle } from '@ultimat3/jobs';
import { job, t } from '@ultimat3/jobs';
import { proveCrash } from './exercise-crash';
import { CRASH_POINT_BOUND } from './job-crash-points';
import { crashProof } from './job-crash-proof';
import { captureNetwork, mockFetch, restoreCapturedNetwork } from './sealed-network';

let minted = 0;
const named = (stem: string): string => {
  minted += 1;
  return `crash-bound-${stem}-${String(minted)}`;
};

const uuidOf = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
/** A slug with no digit and no id in it: what an app names a step by when it is not the row's id. */
const slugOf = (i: number): string =>
  i
    .toString(26)
    .split('')
    .map((c) => String.fromCharCode(97 + Number.parseInt(c, 26)))
    .join('');

interface Sweep {
  readonly handle: JobHandle<{ readonly at: string }>;
  /** Every time the body started: one per attempt of every run the proof made. */
  readonly attempts: () => number;
}

/** A sweep over `rows` module rows — the shape of a job that reads every seeded row of a table. */
function sweep(
  rows: number,
  options: { readonly stepName?: (i: number) => string; readonly between?: boolean } = {},
): Sweep {
  let attempts = 0;
  const stepName = options.stepName ?? ((i: number) => `fanout:${uuidOf(i)}`);
  const handle = job<{ readonly at: string }>({
    name: named('sweep'),
    input: t.object({ at: t.string }),
    tenant: 'none',
    idempotencyKey: (input) => `sweep:${input.at}`,
    retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: 'none' },
    run: async ({ step }) => {
      attempts += 1;
      await step.run('load', () => rows);
      for (let i = 0; i < rows; i += 1) {
        // Planted: a call out between two rows, outside every step — the retry makes it again.
        if (options.between === true && i === 1) {
          await fetch('https://hook.example/progress', { method: 'POST' });
        }
        await step.run(stepName(i), () => i);
      }
      await step.run('mark', () => 'swept');
    },
  });
  return { handle, attempts: () => attempts };
}

const AT = { at: 'nightly' };

let network = captureNetwork();
beforeEach(() => {
  network = captureNetwork();
  mockFetch(/^https:\/\/hook\.example\//, () => new Response('{}'));
});
afterEach(() => {
  restoreCapturedNetwork(network);
});

describe('crashProof: a sweep costs O(steps), not O(rows)', () => {
  test('the runs a sweep of 40 rows costs are the runs a sweep of 3 costs', async () => {
    const small = sweep(3);
    const large = sweep(40);
    const few = await crashProof(small.handle, AT);
    const many = await crashProof(large.handle, AT);

    expect(many.crossed).toBe(40 + 3);
    expect(many.boundaries).toHaveLength(few.boundaries.length);
    expect(many.boundaries.map((one) => one.at)).toEqual([
      'load',
      `fanout:${uuidOf(0)}`,
      `fanout:${uuidOf(39)}`,
      'mark',
      'ack',
    ]);
    expect(large.attempts()).toBe(small.attempts());
    expect(many.divergences).toEqual([]);
  });

  test('an effect between two rows is still caught in a sweep of 40', async () => {
    const report = await crashProof(sweep(40, { between: true }).handle, AT);
    expect(report.divergences.map((one) => one.effect)).toContain(
      'network:POST hook.example/progress',
    );
    expect(report.divergences[0]?.error.cause).toContain(`after step "fanout:${uuidOf(0)}"`);
  });

  test('steps named by numbers collapse as ids do', async () => {
    const report = await crashProof(sweep(30, { stepName: (i) => `page-${String(i)}` }).handle, AT);
    expect(report.boundaries.map((one) => one.at)).toEqual([
      'load',
      'page-0',
      'page-29',
      'mark',
      'ack',
    ]);
  });
});

describe('crashProof: past its bound it refuses, never passes', () => {
  test(`more than ${String(CRASH_POINT_BOUND)} distinct boundaries is X_JOB_CRASH_UNBOUNDED`, async () => {
    const slugged = sweep(CRASH_POINT_BOUND + 1, { stepName: (i) => `notify:${slugOf(i)}` });
    const refused = await crashProof(slugged.handle, AT).then(
      () => expect.unreachable('a proof past its bound must refuse'),
      (error: unknown) => error,
    );
    expect(refused).toBeUltimateError('X_JOB_CRASH_UNBOUNDED');
    // One clean run, then the refusal: the bound is judged before the first kill.
    expect(slugged.attempts()).toBe(1);
  });

  test('the exercise pass reports it unproven, with the code and the reason', async () => {
    const slugged = sweep(CRASH_POINT_BOUND + 1, { stepName: (i) => `notify:${slugOf(i)}` });
    const proof = await proveCrash(slugged.handle, AT, null);
    expect(proof.verdict).toBe('unproven');
    expect(proof.verdict === 'unproven' ? proof.reason : '').toStartWith('X_JOB_CRASH_UNBOUNDED: ');
  });
});
