// A signal during boot is a drain, not a kill. `runRole` installed its signal handlers only after
// `serveApp` returned, while the worker starts claiming inside `startRoles` — so a SIGTERM landing
// between the two (a rollout replacing a pod still booting) found no handler, and Bun's default
// ended a process holding claimed jobs: every one waited out its visibility timeout.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Ctx,
  configureLifecycle,
  createContext,
  lifecycleState,
  resetLifecycle,
} from '@ultimat3/core';
import type { JobDriver, NackOptions, QueueStats } from '@ultimat3/jobs';
import { createWorker, job, memoryJobDriver, resetJobs, type Worker } from '@ultimat3/jobs';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { holdWhileBooting } from './hold';

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

/** Listeners on SIGTERM — what decides whether the process drains or simply dies. */
const sigtermListeners = (): number => process.listenerCount('SIGTERM');

beforeEach(() => {
  resetLifecycle();
  resetJobs();
});

afterEach(() => {
  resetLifecycle();
  resetJobs();
});

describe('holdWhileBooting', () => {
  test('a SIGTERM during boot drains the worker the boot started: its job handed back', async () => {
    configureLifecycle({ deadlineMs: 200 });
    const base = memoryJobDriver();
    const nacks: NackOptions[] = [];
    let atClose: QueueStats | undefined;
    const driver: JobDriver = {
      ...base,
      async nack(jobId: string, options: NackOptions): Promise<boolean> {
        nacks.push(options);
        return base.nack(jobId, options);
      },
      async close(): Promise<void> {
        [atClose] = await base.stats();
      },
    };
    let started = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    job<{ n: number }>({
      tenant: 'none',
      name: 'bootJob',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `boot:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async () => {
        started();
        await finished;
      },
    });
    await driver.enqueue({
      name: 'bootJob',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: 'boot:1',
      maxAttempts: 1,
    });

    const before = sigtermListeners();
    const codes: number[] = [];
    let stateAfterSignal: string | undefined;
    const booted = await holdWhileBooting(
      'probe',
      async () => {
        const worker: Worker = createWorker({ driver, context, pollIntervalMs: 1 });
        worker.start();
        await running;
        // The signal, as the kernel delivers it: to whatever listens. Before the fix nothing did
        // yet — the handlers were installed after this function returned.
        process.emit('SIGTERM', 'SIGTERM');
        stateAfterSignal = lifecycleState();
        // The rest of a slow boot: the island build, the replicator, the live feed.
        await Bun.sleep(20);
        return { stop: () => worker.stop() };
      },
      { exit: (code) => codes.push(code) },
    );
    await booted.hold();
    finish();

    expect(stateAfterSignal).toBe('draining');
    // Handed back uncounted at the cut-off, so the replacement claims it at once.
    expect(nacks.map((nack) => nack.countsAsAttempt)).toEqual([false]);
    expect(atClose?.ready).toBe(1);
    expect(codes).toEqual([0]);
    expect(sigtermListeners()).toBe(before);
  });

  test('a boot that fails gives the handlers back and rethrows its own error', async () => {
    const before = sigtermListeners();
    const refusal = new Error('the boot refused');

    const outcome = await holdWhileBooting('probe', () => Promise.reject(refusal)).catch(
      (error: unknown) => error,
    );

    expect(outcome).toBe(refusal);
    expect(sigtermListeners()).toBe(before);
  });

  test('a boot with no signal returns the app, and the hold waits for a shutdown', async () => {
    let stopped = 0;
    const booted = await holdWhileBooting('probe', async () => ({
      stop: async () => {
        stopped += 1;
      },
      role: 'worker',
    }));

    expect(booted.app.role).toBe('worker');
    expect(stopped).toBe(0);
    const held = booted.hold();
    process.emit('SIGTERM', 'SIGTERM');
    await held;
    expect(stopped).toBe(1);
  });
});
