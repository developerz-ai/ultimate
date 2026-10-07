// `ROLE=worker`'s retire on SIGUSR2: stop claiming, finish every held job however long it takes,
// abort nothing — then the ordinary drain, so the process exits 0 and a Kubernetes `preStop` that
// waits for PID 1 to go away sees the retire finish. Driven through a fake signal source.

import { describe, expect, test } from 'bun:test';
import { InternalError, setLogSink } from '@ultimat3/core';
import type { WorkerStats } from '@ultimat3/jobs';
import { armWorkerRetire, RETIRE_SIGNAL, type RetireSignals } from './serve-retire';

const statsHolding = (inFlight: number, state: WorkerStats['state']): WorkerStats => ({
  workerId: 'worker-test',
  queues: ['default'],
  state,
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

/** A signal source a test raises by hand, counting the listeners it holds. */
function fakeSignals(): RetireSignals & { raise(signal: string): void; held(): number } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on(signal, listener) {
      const set = listeners.get(signal) ?? new Set();
      set.add(listener);
      listeners.set(signal, set);
    },
    off(signal, listener) {
      listeners.get(signal)?.delete(listener);
    },
    raise(signal) {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
    held: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

/** A worker holding one job until `finish()`. */
function heldWorker() {
  const events: string[] = [];
  let finish = (): void => {};
  let state: WorkerStats['state'] = 'running';
  const stopped = new Promise<void>((resolve) => {
    finish = () => {
      state = 'stopped';
      events.push('jobs finished');
      resolve();
    };
  });
  return {
    events,
    finish: () => finish(),
    worker: {
      stats: () => Promise.resolve(statsHolding(state === 'running' ? 1 : 0, state)),
      stop: (reason?: string) => {
        events.push(`stop:${reason ?? ''}`);
        return stopped;
      },
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function logged(): { readonly lines: Record<string, unknown>[]; restore(): void } {
  const lines: Record<string, unknown>[] = [];
  const previous = setLogSink((line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { lines, restore: () => setLogSink(previous) };
}

describe('unit · armWorkerRetire', () => {
  test('the signal retires the worker, waits for its jobs, then drains — and logs both ends', async () => {
    const signals = fakeSignals();
    const held = heldWorker();
    const log = logged();
    try {
      const retire = armWorkerRetire({
        platform: 'linux',
        signals,
        drain: (signal) => {
          held.events.push(`drain:${signal}`);
          return Promise.resolve();
        },
      });
      retire.adopt(held.worker);
      signals.raise(RETIRE_SIGNAL);
      await tick();
      expect(held.events).toEqual([`stop:${RETIRE_SIGNAL}`]);
      held.finish();
      await tick();
      expect(held.events).toEqual([
        `stop:${RETIRE_SIGNAL}`,
        'jobs finished',
        `drain:${RETIRE_SIGNAL}`,
      ]);
      const messages = log.lines.map((line) => line['msg']);
      expect(messages).toContain('jobs.worker.retiring');
      expect(messages).toContain('jobs.worker.retired');
      expect(log.lines.find((line) => line['msg'] === 'jobs.worker.retiring')?.['inFlight']).toBe(
        1,
      );
    } finally {
      log.restore();
    }
  });

  test('a second signal joins the retire in flight', async () => {
    const signals = fakeSignals();
    const held = heldWorker();
    const retire = armWorkerRetire({ platform: 'linux', signals, drain: () => Promise.resolve() });
    retire.adopt(held.worker);
    signals.raise(RETIRE_SIGNAL);
    signals.raise(RETIRE_SIGNAL);
    await tick();
    expect(held.events.filter((event) => event.startsWith('stop:'))).toHaveLength(1);
    held.finish();
  });

  test('a signal during boot waits for the worker, then retires it', async () => {
    const signals = fakeSignals();
    const held = heldWorker();
    const retire = armWorkerRetire({ platform: 'linux', signals, drain: () => Promise.resolve() });
    signals.raise(RETIRE_SIGNAL);
    await tick();
    expect(held.events).toEqual([]);
    retire.adopt(held.worker);
    await tick();
    expect(held.events).toEqual([`stop:${RETIRE_SIGNAL}`]);
    held.finish();
  });

  test('a retire that fails still drains: a worker that stopped claiming must not hold the pod', async () => {
    const signals = fakeSignals();
    const drained: string[] = [];
    const retire = armWorkerRetire({
      platform: 'linux',
      signals,
      drain: (signal) => {
        drained.push(signal);
        return Promise.resolve();
      },
    });
    retire.adopt({
      stats: () =>
        Promise.reject(new InternalError({ cause: 'pool gone', fix: 'x doctor --json' })),
      stop: () => Promise.resolve(),
    });
    signals.raise(RETIRE_SIGNAL);
    await tick();
    expect(drained).toEqual([RETIRE_SIGNAL]);
  });

  test('disarm gives the listener back', () => {
    const signals = fakeSignals();
    const retire = armWorkerRetire({ platform: 'linux', signals, drain: () => Promise.resolve() });
    expect(signals.held()).toBe(1);
    retire.disarm();
    expect(signals.held()).toBe(0);
  });

  test('Windows has no SIGUSR2: nothing is installed and nothing retires', async () => {
    const signals = fakeSignals();
    const held = heldWorker();
    const retire = armWorkerRetire({ platform: 'win32', signals, drain: () => Promise.resolve() });
    retire.adopt(held.worker);
    expect(signals.held()).toBe(0);
    signals.raise(RETIRE_SIGNAL);
    await tick();
    expect(held.events).toEqual([]);
  });
});
