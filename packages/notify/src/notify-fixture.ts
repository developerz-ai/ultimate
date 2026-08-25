// The harness every fan-out test drives a notifier through: a real step runner over a memory step
// store, a frozen clock, and a recording channel. Shared rather than copied because the replay
// tests and the wait tests must drive the SAME run — two harnesses that drifted would be two
// fan-outs agreeing only by construction.
//
// `handle.run(...)` and not `executeJob`: this package owns the fan-out, and `execute.ts` already
// owns what a driver does with the outcome. A `-fixture.ts` file is excluded from the tarball.

import type { Ctx, FrozenClock } from '@ultimat3/core';
import { assert, createContext, frozenClock } from '@ultimat3/core';
import type { JobHandle, StepStore } from '@ultimat3/jobs';
import { createMemoryStepStore, createStepRunner, isStepSuspension } from '@ultimat3/jobs';
import type { BulkNotifyChannel, NotifyChannel } from './channel';
import { bulkChannel, channel } from './channel';
import type { NotifyPayload, NotifyReport } from './plan';

/** One `deliver` call, flattened so a test asserts on data rather than on a mock's call log. */
export interface Sent {
  readonly channel: string;
  /** Who this ONE call covered — one id for an individual channel, many for a bulk one. */
  readonly to: readonly string[];
  /** The event keys the call carried, oldest first. Length > 1 means a digest flushed. */
  readonly events: readonly string[];
}

export interface Recorder {
  readonly sent: readonly Sent[];
  /** An individual channel that records and never throws. */
  one(name: string): NotifyChannel<TestParams>;
  /** An individual channel whose `deliver` rejects, for the failure path. */
  broken(name: string, reject: () => unknown): NotifyChannel<TestParams>;
  /** A bulk channel: ONE call for the whole audience. */
  many(name: string): BulkNotifyChannel<TestParams>;
}

/** Mirrors `t.object({ postId: t.uuid })`'s output exactly — a `readonly` here would make the
 * schema and the declaration two different types, because `Schema.default(value: Out)` puts `Out`
 * in a contravariant position and kills the assignability a plain covariant read would have. */
export interface TestParams {
  postId: string;
}

export function recorder(): Recorder {
  const sent: Sent[] = [];
  return {
    sent,
    one: (name) =>
      channel<TestParams>(name, ({ recipient, batch }) => {
        sent.push({ channel: name, to: [recipient.id], events: batch.map((e) => e.key) });
      }),
    broken: (name, reject) =>
      channel<TestParams>(name, () => {
        throw reject();
      }),
    many: (name) =>
      bulkChannel<TestParams>(name, ({ recipients, batch }) => {
        sent.push({
          channel: name,
          to: recipients.map((recipient) => recipient.id),
          events: batch.map((e) => e.key),
        });
      }),
  };
}

export const START = Date.parse('2026-08-24T09:00:00Z');

export interface Driver {
  readonly clock: FrozenClock;
  readonly ctx: Ctx;
  readonly store: StepStore;
  /** Attempts this driver has made. A replay is an attempt that found its steps already done. */
  readonly attempts: number;
  /** One attempt. Answers the report, or `undefined` when the run suspended on a sleep. */
  once(
    handle: JobHandle<NotifyPayload<TestParams>>,
    payload: NotifyPayload<TestParams>,
  ): Promise<NotifyReport | undefined>;
  /** Attempts until the run completes, advancing the clock to each suspension's wake time. */
  finish(
    handle: JobHandle<NotifyPayload<TestParams>>,
    payload: NotifyPayload<TestParams>,
  ): Promise<NotifyReport>;
}

export const RUN_ID = 'run-notify-1';

/** Suspensions one `finish()` will resume through before it calls the run stuck. */
const MAX_ATTEMPTS = 20;

/**
 * Every `once()` is a fresh attempt against the SAME store and run id, which is exactly what a
 * retry is — and what makes "a replayed attempt does not double-send" a real assertion rather than
 * a second first attempt.
 */
export function driver(options: { store?: StepStore; runId?: string } = {}): Driver {
  const clock = frozenClock(START);
  const ctx = createContext({ clock });
  const store = options.store ?? createMemoryStepStore();
  const runId = options.runId ?? RUN_ID;
  let attempts = 0;

  const once = async (
    handle: JobHandle<NotifyPayload<TestParams>>,
    payload: NotifyPayload<TestParams>,
  ): Promise<NotifyReport | undefined> => {
    attempts += 1;
    const runner = createStepRunner({ runId, jobName: handle.name, store, clock });
    try {
      return (await handle.run({
        input: payload,
        step: runner.step,
        ctx,
        attempt: attempts,
        jobId: 'job-notify-1',
        runId,
      })) as NotifyReport;
    } catch (error) {
      // A suspension is control flow, never a failure: the worker would park the run and claim it
      // again at `resumeAt`, so the harness does the same rather than swallowing it.
      if (isStepSuspension(error)) {
        clock.set(error.resumeAt);
        return undefined;
      }
      throw error;
    }
  };

  return {
    clock,
    ctx,
    store,
    get attempts(): number {
      return attempts;
    },
    once,
    async finish(handle, payload) {
      // Bounded rather than `while (true)`: a fan-out that never settles is a bug this harness
      // must report as one, not hang on. `assert` and never a bare `Error` — a harness states its
      // verdict through the framework's own contract, tests included.
      let report: NotifyReport | undefined;
      for (let pass = 0; pass < MAX_ATTEMPTS && report === undefined; pass += 1) {
        report = await once(handle, payload);
      }
      assert(
        report !== undefined,
        `notifier "${handle.name}" did not finish in ${String(MAX_ATTEMPTS)} attempts`,
        `shorten the wait or digest window the test declares on notifier("${handle.name}"), or raise MAX_ATTEMPTS in notify-fixture.ts`,
      );
      return report;
    },
  };
}
