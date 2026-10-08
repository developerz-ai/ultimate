// A save that restarts `x dev` never cancels a running job (issue #677): the worker is retired
// first — stop claiming, finish what it holds — and only then does the process drain and exit.

import { describe, expect, test } from 'bun:test';
import { InternalError, isRetiring, resetLifecycle } from '@ultimat3/core';
import type { WorkerStats } from '@ultimat3/jobs';
import { type RetiringWorker, retireThenDrain } from './dev-restart-retire';

const statsHolding = (inFlight: number): WorkerStats => ({
  workerId: 'worker-test',
  queues: ['default'],
  state: 'running',
  inFlight,
  processed: 0,
  failed: 0,
  suspended: 0,
  deadLettered: 0,
  interrupted: 0,
  refused: 0,
  dropped: 0,
  pollDelayMs: 250,
  queueDepth: [],
});

/** A worker holding `inFlight` jobs whose `stop()` settles when the test says so. */
function heldWorker(inFlight: number): {
  readonly worker: RetiringWorker;
  readonly events: string[];
  finish(): void;
} {
  const events: string[] = [];
  let finish = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    finish = () => {
      events.push('jobs finished');
      resolve();
    };
  });
  const worker: RetiringWorker = {
    stats: () => Promise.resolve(statsHolding(inFlight)),
    stop: (reason?: string) => {
      events.push(`stop:${reason ?? ''}`);
      return stopped;
    },
  };
  return { worker, events, finish: () => finish() };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('unit · retireThenDrain', () => {
  test('the drain waits for the jobs the worker holds, and the wait is said once', async () => {
    const held = heldWorker(2);
    const said: string[] = [];
    const done = retireThenDrain(held.worker, {
      drain: (reason) => {
        held.events.push(`drain:${reason}`);
        return Promise.resolve();
      },
      say: (line) => said.push(line),
    });
    await tick();
    expect(held.events).toEqual(['stop:x dev restart']);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('2 running job(s)');
    held.finish();
    await done;
    expect(held.events).toEqual(['stop:x dev restart', 'jobs finished', 'drain:restart']);
  });

  test('a worker holding nothing says nothing and the drain follows at once', async () => {
    const held = heldWorker(0);
    held.finish();
    const said: string[] = [];
    await retireThenDrain(held.worker, {
      drain: (reason) => {
        held.events.push(`drain:${reason}`);
        return Promise.resolve();
      },
      say: (line) => said.push(line),
    });
    expect(said).toEqual([]);
    expect(held.events.at(-1)).toBe('drain:restart');
  });

  test('no worker in this process is the drain alone', async () => {
    const drained: string[] = [];
    await retireThenDrain(null, {
      drain: (reason) => {
        drained.push(reason);
        return Promise.resolve();
      },
      say: () => undefined,
    });
    expect(drained).toEqual(['restart']);
  });

  test('a retire that fails still drains: the restart is never left half-done', async () => {
    const drained: string[] = [];
    const broken: RetiringWorker = {
      stats: () =>
        Promise.reject(new InternalError({ cause: 'pool closed', fix: 'restart x dev' })),
      stop: () => Promise.resolve(),
    };
    await retireThenDrain(broken, {
      drain: (reason) => {
        drained.push(reason);
        return Promise.resolve();
      },
      say: () => undefined,
    });
    expect(drained).toEqual(['restart']);
  });

  test('the restart is a retire the app can read: isRetiring() is true when the worker stops', async () => {
    resetLifecycle();
    try {
      const held = heldWorker(1);
      let retiringAtStop: boolean | undefined;
      const done = retireThenDrain(
        {
          stats: held.worker.stats,
          stop: (reason) => {
            retiringAtStop = isRetiring();
            return held.worker.stop(reason);
          },
        },
        { drain: () => Promise.resolve(), say: () => undefined },
      );
      await tick();
      expect(retiringAtStop).toBe(true);
      held.finish();
      await done;
    } finally {
      resetLifecycle();
    }
  });
});
