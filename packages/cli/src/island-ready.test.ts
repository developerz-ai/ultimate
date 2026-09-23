// #474, reproduced: the harness set `ready` after fonts and a few quiet frames and never cleared it,
// while an island on the `idle` strategy mounts up to IDLE_HYDRATE_TIMEOUT_MS later — idle time
// the activity counter does not see. `settleReadiness` stopped on `ready`, so on a busy machine the
// capture read `mounted: false` and reported "did not finish mounting" with the window unused.

import { describe, expect, test } from 'bun:test';
import { HARNESS_GLOBAL, harnessScript } from './island-harness-script';
import type { IslandReadiness } from './island-verdict';
import { settleReadiness } from './shot-settle';

const readiness = (mounted: boolean): IslandReadiness =>
  ({ harness: true, ready: true, mounted, failed: null }) as unknown as IslandReadiness;

describe('unit · the settle waits for the mount, not only for quiet (#474)', () => {
  test('ready-but-unmounted keeps polling inside the window, and the mount is seen', async () => {
    const answers = [false, false, false, true].map(readiness);
    let calls = 0;
    const settled = await settleReadiness(async () => answers[Math.min(calls++, 3)] ?? null, {
      windowMs: 1000,
      pollMs: 10,
      sleep: async () => undefined,
    });
    expect(settled?.mounted).toBe(true);
    expect(calls).toBe(4);
  });

  test('a failed mount is an answer too, and ends the wait', async () => {
    let calls = 0;
    const failed = { ...readiness(false), failed: 'boom' } as IslandReadiness;
    const settled = await settleReadiness(async () => (calls++ === 0 ? readiness(false) : failed), {
      windowMs: 1000,
      pollMs: 10,
      sleep: async () => undefined,
    });
    expect(settled?.failed).toBe('boom');
    expect(calls).toBe(2);
  });

  test('the page counts quiet frames only once the island has mounted or failed', async () => {
    const frames: (() => void)[] = [];
    const host = {
      mounted: false,
      hasAttribute: (name: string) => name === 'data-x-mounted' && host.mounted,
    };
    const window: Record<string, unknown> = {};
    const document = {
      fonts: { ready: Promise.resolve() },
      querySelector: () => host,
    };
    const script = harnessScript({ stubs: [], now: '2026-03-04T09:00:00.000Z', timeZone: 'UTC' });
    new Function('window', 'document', 'navigator', 'requestAnimationFrame', script)(
      window,
      document,
      {},
      (fn: () => void) => frames.push(fn),
    );
    await Promise.resolve();
    await Promise.resolve();
    const run = (count: number): void => {
      for (let i = 0; i < count; i += 1) frames.shift()?.();
    };
    const state = window[HARNESS_GLOBAL] as { ready: boolean };
    run(20);
    expect(state.ready).toBe(false);
    host.mounted = true;
    run(20);
    expect(state.ready).toBe(true);
  });
});
