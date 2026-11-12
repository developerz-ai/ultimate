// The registry's renewal is NARROW when nothing a reader uses changed: the full row (queues and
// in-flight jsonb) is rewritten only when the held jobs or the drain flag moved, and a renew that
// finds no live row (lapsed, swept) falls back to the full announce that recreates it.

import { describe, expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import type { WorkerAnnouncement } from './introspection';
import { startWorkerRegistry } from './worker-registry';

interface Harness {
  readonly calls: string[];
  readonly tick: () => Promise<void>;
  readonly held: string[];
  live: boolean;
}

function harness(
  withRenew: boolean,
): Harness & { start: () => ReturnType<typeof startWorkerRegistry> } {
  const calls: string[] = [];
  const held: string[] = [];
  const ticks: (() => void)[] = [];
  const state: Harness = {
    calls,
    held,
    live: true,
    tick: async () => {
      for (const tick of ticks) tick();
      // Microtask turns only — the renew, then its full fallback — never a timer.
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    },
  };
  const introspect = {
    announceWorker: (worker: WorkerAnnouncement, ttlMs: number) => {
      calls.push(
        `announce ${worker.inFlight.join(',')}${worker.draining ? ' draining' : ''} ${ttlMs}`,
      );
      state.live = true;
      return Promise.resolve();
    },
    forgetWorker: () => Promise.resolve(),
    ...(withRenew
      ? {
          renewWorker: (id: string, ttlMs: number) => {
            calls.push(`renew ${id} ${ttlMs}`);
            return Promise.resolve(state.live);
          },
        }
      : {}),
  };
  const driver = { name: 'probe', introspect } as unknown as JobDriver;
  return {
    ...state,
    get live() {
      return state.live;
    },
    set live(value: boolean) {
      state.live = value;
    },
    start: () =>
      startWorkerRegistry({
        driver,
        workerId: 'w-1',
        host: 'pod-1',
        queues: ['default'],
        concurrency: 2,
        inFlight: () => [...held],
        ttlMs: 60_000,
        intervalMs: 20_000,
        schedule: (tick) => {
          ticks.push(tick);
          return () => undefined;
        },
      }),
  };
}

describe('worker registry renewal', () => {
  test('an unchanged row is renewed narrowly; a changed one is announced in full', async () => {
    const probe = harness(true);
    const registration = probe.start();
    await probe.tick();
    await probe.tick();
    probe.held.push('job-a');
    await probe.tick();
    await probe.tick();
    await registration.draining();
    await probe.tick();
    await registration.stop();
    expect(probe.calls).toEqual([
      'announce  60000',
      'renew w-1 60000',
      'renew w-1 60000',
      'announce job-a 60000',
      'renew w-1 60000',
      'announce job-a draining 60000',
      'renew w-1 60000',
    ]);
  });

  test('a renew that finds no live row announces in full at once: a lapsed worker reappears', async () => {
    const probe = harness(true);
    const registration = probe.start();
    await probe.tick();
    probe.live = false;
    await probe.tick();
    await registration.stop();
    expect(probe.calls).toEqual([
      'announce  60000',
      'renew w-1 60000',
      'renew w-1 60000',
      'announce  60000',
    ]);
  });

  test('a driver with no narrow renew is announced in full every time, as before', async () => {
    const probe = harness(false);
    const registration = probe.start();
    await probe.tick();
    await probe.tick();
    await registration.stop();
    expect(probe.calls).toEqual(['announce  60000', 'announce  60000', 'announce  60000']);
  });
});
