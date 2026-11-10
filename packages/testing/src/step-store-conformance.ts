// The `StepStore` contract of `@ultimat3/jobs` as shared examples: `behavesLike(stepStoreConformance,
// () => driver)`. The subject is the store AND the queue it is fenced on — a write made under a
// claim lands only while that claim holds the row, and only a queue row can say so. Any `JobDriver`
// is one; a store of your own goes in as `memoryJobDriver({ steps: yours })` or inside your driver.

import { expect, test } from 'bun:test';
import type { JobDriver, StepFence, StepRecord } from '@ultimat3/jobs';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

/** The step store under test and the slice of its queue a fence needs. */
export type StepStoreSubject = Pick<JobDriver, 'steps' | 'enqueue' | 'claim' | 'ack'>;

export interface StepStoreCheck {
  readonly name: string;
  run(subject: StepStoreSubject): Promise<void>;
}

const AT = Date.UTC(2026, 10, 9, 9, 0, 0);

let minted = 0;
const tag = (): string => {
  minted += 1;
  return `${process.pid.toString(36)}-${minted.toString(36)}`;
};

const step = (runId: string, name: string, extra: Partial<StepRecord> = {}): StepRecord => ({
  runId,
  name,
  status: 'completed',
  output: { name },
  startedAt: AT,
  completedAt: AT + 5,
  attempts: 1,
  ...extra,
});

/** A claimed row of a queue of this check's own, and the fence its claim writes under. */
async function claimed(subject: StepStoreSubject): Promise<{ runId: string; fence: StepFence }> {
  const at = tag();
  const [queue, job] = [`conformance-steps-${at}`, `conformance.steps-${at}`];
  await subject.enqueue({ name: job, queue, input: {}, idempotencyKey: at, maxAttempts: 3 });
  const [row] = await subject.claim({
    queues: [queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'conformance-worker',
  });
  if (row === undefined) return expect.unreachable('a row enqueued on its own queue is claimable');
  const fence = { job, jobId: row.id, workerId: row.claimedBy, claim: row.claim };
  return { runId: row.runId, fence };
}

const leaseLost = { code: 'X_JOB_LEASE_LOST' };

export const STEP_STORE_CHECKS: readonly StepStoreCheck[] = [
  {
    name: 'a step nobody wrote is undefined, and a run nobody wrote lists nothing',
    async run({ steps }) {
      const runId = crypto.randomUUID();
      expect(await steps.get(runId, 'absent')).toBeUndefined();
      expect(await steps.list(runId)).toEqual([]);
    },
  },
  {
    name: 'every field of a record reads back as it was written',
    async run({ steps }) {
      const runId = crypto.randomUUID();
      const waiting = step(runId, 'wait', {
        status: 'waiting',
        output: { floor: 7 },
        wakeAt: AT + 60_000,
        event: 'paid',
        correlationKey: 'order-1',
        attempts: 2,
        error: 'boom',
      });
      await steps.put(waiting);
      expect(await steps.get(runId, 'wait')).toEqual(waiting);
      expect(await steps.list(runId)).toEqual([waiting]);
    },
  },
  {
    // A live reference replayed a `Date` under one store and a string under another: a step that
    // worked in every test broke on its first retry in production.
    name: 'an output is stored as JSON carries it: a Date as its string, undefined as null',
    async run({ steps }) {
      const runId = crypto.randomUUID();
      const date = new Date(AT);
      const cases: readonly (readonly [string, unknown, unknown])[] = [
        ['date', { at: date }, { at: date.toISOString() }],
        ['undefined', undefined, null],
        ['member', { a: undefined, b: 1 }, { b: 1 }],
        ['map', new Map([['k', 1]]), {}],
      ];
      for (const [name, output] of cases) await steps.put(step(runId, name, { output }));
      for (const [name, , stored] of cases) {
        expect((await steps.get(runId, name))?.output).toEqual(stored);
      }
    },
  },
  {
    name: 'a second put of one (run, name) replaces the first',
    async run({ steps }) {
      const runId = crypto.randomUUID();
      await steps.put(step(runId, 'nap', { status: 'sleeping', output: null, wakeAt: AT + 9 }));
      const done = step(runId, 'nap', { output: 'woke', attempts: 2 });
      await steps.put(done);
      expect(await steps.list(runId)).toEqual([done]);
    },
  },
  {
    name: 'list reads one run in start order; del and clear scope by run',
    async run({ steps }) {
      const [runId, other] = [crypto.randomUUID(), crypto.randomUUID()];
      const [late, early, mid] = [
        step(runId, 'late', { startedAt: AT + 20 }),
        step(runId, 'early', { startedAt: AT }),
        step(runId, 'mid', { startedAt: AT + 10 }),
      ];
      for (const each of [late, early, mid, step(other, 'kept')]) await steps.put(each);
      expect((await steps.list(runId)).map((each) => each.name)).toEqual(['early', 'mid', 'late']);
      await steps.del(runId, 'mid');
      expect((await steps.list(runId)).map((each) => each.name)).toEqual(['early', 'late']);
      await steps.clear(runId);
      expect(await steps.list(runId)).toEqual([]);
      expect((await steps.list(other)).map((each) => each.name)).toEqual(['kept']);
    },
  },
  {
    name: 'a write under a claim that still holds the row lands',
    async run(subject) {
      const { runId, fence } = await claimed(subject);
      await subject.steps.put(step(runId, 'fenced'), fence);
      expect((await subject.steps.get(runId, 'fenced'))?.status).toBe('completed');
    },
  },
  {
    // The in-process abort cannot stop a body in ANOTHER process whose lease lapsed; this can.
    name: 'a write under another claim of the row is X_JOB_LEASE_LOST and writes nothing',
    async run(subject) {
      const { runId, fence } = await claimed(subject);
      const stale = [
        { ...fence, claim: fence.claim + 1 },
        { ...fence, workerId: 'another' },
      ];
      for (const by of stale) {
        await expect(subject.steps.put(step(runId, 'stale'), by)).rejects.toMatchObject(leaseLost);
      }
      expect(await subject.steps.get(runId, 'stale')).toBeUndefined();
    },
  },
  {
    name: 'a write under a claim whose row was settled is X_JOB_LEASE_LOST',
    async run(subject) {
      const { runId, fence } = await claimed(subject);
      expect(await subject.ack(fence.jobId, fence)).toBe(true);
      await expect(subject.steps.put(step(runId, 'late'), fence)).rejects.toMatchObject(leaseLost);
      expect(await subject.steps.get(runId, 'late')).toBeUndefined();
    },
  },
];

export const stepStoreConformance: SharedExamples<StepStoreSubject | Promise<StepStoreSubject>> =
  sharedExamples('a step store', (subject) => {
    for (const check of STEP_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
