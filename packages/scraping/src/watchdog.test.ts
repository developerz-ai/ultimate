// The two named incidents, as tests. One run held a queue slot for 3h11m with an open socket and
// no timeout armed; another left a browser alive after its run and pinned the queue until a
// redeploy. Both are one mechanism away, and this file is that mechanism failing on purpose.

import { describe, expect, test } from 'bun:test';
import { testClock } from './clock';
import { createWedgeGuard } from './watchdog';

const settled = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => resolve()));

describe('unit · the inactivity watchdog', () => {
  test('silence past idleMs KILLS the process and aborts with X_SCRAPE_WEDGED', async () => {
    const clock = testClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: () => Promise.resolve(),
      kill: () => {
        killed += 1;
      },
    });
    for (let tick = 0; tick < 20 && !guard.fired; tick += 1) await settled();
    expect(guard.fired).toBe(true);
    expect(killed).toBe(1);
    expect(guard.signal.aborted).toBe(true);
    expect((guard.signal.reason as { code?: string }).code).toBe('X_SCRAPE_WEDGED');
  });

  test('a run that keeps touching is never killed', async () => {
    const clock = testClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: () => Promise.resolve(),
      kill: () => {
        killed += 1;
      },
    });
    for (let tick = 0; tick < 20; tick += 1) {
      guard.touch();
      await settled();
    }
    expect(guard.fired).toBe(false);
    expect(killed).toBe(0);
    await guard.shutdown();
  });
});

describe('unit · the graceful-quit ceiling', () => {
  test('a quit that returns in time is not followed by a kill', async () => {
    const clock = testClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 60_000,
      graceMs: 5_000,
      quit: () => Promise.resolve(),
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(killed).toBe(0);
  });

  test('a quit that never returns is killed at the ceiling — the zombie incident', async () => {
    const clock = testClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 60_000,
      graceMs: 5_000,
      // `browser.close()` on a wedged renderer never returns. Waiting for it is the incident.
      quit: () => new Promise<void>(() => undefined),
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(killed).toBe(1);
  });

  test('a quit that THROWS is still killed — a failed close is not a closed browser', async () => {
    const clock = testClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 60_000,
      quit: () => Promise.reject(new Error('detached')),
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(killed).toBe(1);
  });
});
