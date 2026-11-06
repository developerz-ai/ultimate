// `crashProof` on the probe's job, killed for real: three steps and a call out between the first
// two. Killed after `charge` or before the ack, the call out is made twice — red; after `create`, the
// dead attempt never reached it — green. Wrapped in a step it is green everywhere. A lost answer
// reruns a step and is only reported; a kill inside `once` ends unknown, never as a divergence.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorReporter } from '@ultimat3/core';
import {
  configureErrorReporting,
  errorFingerprint,
  installedErrorReporter,
  resetErrorReporting,
} from '@ultimat3/core';
import type { JobHandle } from '@ultimat3/jobs';
import { job, t } from '@ultimat3/jobs';
import { crashProof } from './job-crash-proof';
import { captureNetwork, mockFetch, restoreCapturedNetwork } from './sealed-network';

interface Order {
  readonly id: string;
}

let minted = 0;
const named = (stem: string): string => {
  minted += 1;
  return `crash-proof-${stem}-${String(minted)}`;
};

const call = (path: string): Promise<Response> =>
  fetch(`https://pay.example/${path}`, { method: 'POST' });

type Body = Parameters<JobHandle<Order>['run']>[0];

const declare = (
  stem: string,
  run: (args: Body) => Promise<unknown>,
  extra: { readonly compensates?: boolean; readonly attempts?: number } = {},
): JobHandle<Order> =>
  job<Order>({
    name: named(stem),
    input: t.object({ id: t.string }),
    tenant: 'none',
    idempotencyKey: (input) => `order:${input.id}`,
    retry: { attempts: extra.attempts ?? 3, backoff: 'fixed', delay: 0, jitter: false },
    ...(extra.compensates === true ? { compensates: true } : {}),
    run,
  });

let network = captureNetwork();
beforeEach(() => {
  network = captureNetwork();
  mockFetch(/^https:\/\/pay\.example\//, () => new Response('{}'));
});
afterEach(() => {
  restoreCapturedNetwork(network);
});

const ORDER = { id: 'o-1' };

describe('crashProof: every boundary of the probe job, killed', () => {
  test('a call out between two steps is made twice when killed after it — and only then', async () => {
    const probe = declare('probe', async ({ step }) => {
      await step.run('create', () => 'created');
      await call('audit');
      await step.run('charge', async () => (await call('charge')).status);
      await step.run('mail', async () => (await call('receipt')).status);
    });
    const report = await crashProof(probe, ORDER);

    expect(report.boundaries.map((one) => one.at)).toEqual(['create', 'charge', 'mail', 'ack']);
    expect(report.boundaries.every((one) => one.state === 'done')).toBe(true);
    const diverged = report.divergences.map((one) => [one.boundary, one.effect, one.killed]);
    expect(diverged).toEqual([
      ['charge', 'network:POST pay.example/audit', 2],
      ['mail', 'network:POST pay.example/audit', 2],
      ['ack', 'network:POST pay.example/audit', 2],
    ]);
    const error = report.divergences[0]?.error;
    expect(error).toBeUltimateError('X_JOB_CRASH_DIVERGED');
    expect(error?.cause).toContain('after step "create"');
    expect(error?.fix).toStartWith('step.run(');
  });

  test('moved into a step, the same job is green at every boundary', async () => {
    const wrapped = declare('wrapped', async ({ step }) => {
      await step.run('create', () => 'created');
      await step.run('audit', async () => (await call('audit')).status);
      await step.run('charge', async () => (await call('charge')).status);
    });
    const report = await crashProof(wrapped, ORDER);
    expect(report.boundaries).toHaveLength(4);
    expect(report.divergences).toEqual([]);
  });

  test('a read outside a step is not an effect', async () => {
    const reads = declare('reads', async ({ step, input }) => {
      const seen = new Map([[input.id, 1]]).get(input.id);
      await step.run('charge', async () => (await call(`charge/${String(seen)}`)).status);
    });
    expect((await crashProof(reads, ORDER)).divergences).toEqual([]);
  });

  test('a lost answer reruns the step it lost — reported, never red', async () => {
    const charged = declare('lost', async ({ step }) => {
      await step.run('charge', async () => (await call('charge')).status);
    });
    const report = await crashProof(charged, ORDER);
    expect(report.divergences).toEqual([]);
    expect(report.reruns).toContainEqual({
      boundary: 'charge',
      effect: 'network:POST pay.example/charge',
      clean: 1,
      rerun: 2,
    });
  });

  test('a kill inside a once step ends X_STEP_OUTCOME_UNKNOWN, with fn run at most once', async () => {
    const once = declare('once', async ({ step }) => {
      await step.run('charge', async () => (await call('charge')).status, { once: true });
    });
    const report = await crashProof(once, ORDER);
    const started = report.boundaries.find((one) => one.at === 'charge (started)');
    expect(started).toMatchObject({ state: 'dead', code: 'X_STEP_OUTCOME_UNKNOWN' });
    expect(report.divergences).toEqual([]);
  });

  test('a job with no step has one boundary, the ack', async () => {
    const bare = declare('bare', async () => {
      await call('charge');
    });
    const report = await crashProof(bare, ORDER);
    expect(report.boundaries.map((one) => one.at)).toEqual(['ack']);
    expect(report.divergences.map((one) => one.effect)).toEqual([
      'network:POST pay.example/charge',
    ]);
  });
});

describe('crashProof: what the process reports is not the job’s effect', () => {
  afterEach(() => {
    resetErrorReporting();
  });

  test('an error sink that enqueues once per new group is neither attributed nor fed', async () => {
    // The shape of `errorGroupsSink` + an app's `onNewGroup`: a store that outlives one run, so
    // whichever run reports a group first enqueues and every later one does not.
    const issue = job<{ fingerprint: string }>({
      name: named('issue'),
      input: t.object({ fingerprint: t.string }),
      tenant: 'none',
      idempotencyKey: ({ fingerprint }) => `issue:${fingerprint}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: false },
      run: async () => undefined,
    });
    const seen = new Set<string>();
    const sink: ErrorReporter = {
      report: (report) => {
        const fingerprint = errorFingerprint(report);
        if (seen.has(fingerprint)) return;
        seen.add(fingerprint);
        void issue.enqueue({ fingerprint });
      },
    };
    configureErrorReporting({ reporter: sink });
    const once = declare('reported', async ({ step }) => {
      await step.run('charge', async () => (await call('charge')).status, { once: true });
    });

    const report = await crashProof(once, ORDER);

    // Killed inside `once`, the run dead-letters X_STEP_OUTCOME_UNKNOWN and is reported: the body
    // made nothing twice, and the sink's enqueue — keyed by fingerprint — is no double effect.
    expect(report.boundaries).toContainEqual(
      expect.objectContaining({ at: 'charge (started)', code: 'X_STEP_OUTCOME_UNKNOWN' }),
    );
    expect(report.divergences).toEqual([]);
    // A planted death is the proof's, never the app's: none reaches its store, and it is put back.
    expect(seen.size).toBe(0);
    expect(installedErrorReporter()).toBe(sink);
  });
});

describe('crashProof: a compensating job, failed for good and killed while it unwinds', () => {
  const saga = (undo: () => Promise<unknown>) =>
    declare(
      'saga',
      async ({ step }) => {
        await step.run('reserve', async () => (await call('reserve')).status, {
          compensate: async () => {
            await call('release');
          },
        });
        await step.run('charge', async () => (await call('charge')).status, {
          compensate: async () => {
            await undo();
          },
        });
      },
      { compensates: true, attempts: 1 },
    );

  test('each compensator runs once, last in first out, at every boundary', async () => {
    const report = await crashProof(
      saga(() => call('refund')),
      ORDER,
    );
    const unwound = report.boundaries.filter((one) => one.mode === 'forced-fail');
    expect(unwound.map((one) => one.at)).toEqual([
      'reserve',
      'charge',
      'unwinding',
      'compensate:charge',
      'compensate:reserve',
      'nack',
    ]);
    expect(report.divergences).toEqual([]);
  });

  test('a compensator that makes its effect twice is red', async () => {
    let refunds = 0;
    const report = await crashProof(
      saga(async () => {
        refunds += 1;
        await call('refund');
        // Planted: every second refund fails after it was sent, so the retry sends it again.
        if (refunds % 2 === 0) await Promise.reject(new Error('the refund provider timed out'));
      }),
      ORDER,
    );
    expect(report.divergences.map((one) => one.effect)).toContain(
      'network:POST pay.example/refund',
    );
  });
});
