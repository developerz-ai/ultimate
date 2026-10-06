// When a shared browser opens and when it closes — over fake browsers, so the count of opens and
// closes is the assertion. The real Chrome under it is `packages/cli/e2e/client-navigation-*`.

import { describe, expect, test } from 'bun:test';
import type { E2eBrowser } from './cdp-browser';
import { E2E_BROWSER_OPEN_MS } from './cdp-browser';
import type { RunEndHook } from './cdp-browser-lease';
import { createE2eBrowserLeases } from './cdp-browser-lease';
import { CdpLaunchFailedError } from './cdp-errors';

/** A browser that counts its closes; nothing else of it is touched here. */
const counted = () => {
  const tally = { opened: 0, closed: 0 };
  const open = async (): Promise<E2eBrowser> => {
    tally.opened += 1;
    return {
      close: async () => {
        tally.closed += 1;
      },
    } as unknown as E2eBrowser;
  };
  return { tally, open };
};

describe('leasing one browser to many suites', () => {
  test('two holders of one key share ONE open, closed when the last is done', async () => {
    const leases = createE2eBrowserLeases();
    const { tally, open } = counted();

    const first = leases.lease('nav', open);
    const second = leases.lease('nav', open);
    expect(await first.opened).toBe(await second.opened);
    expect(tally.opened).toBe(1);

    await first.release();
    expect(tally.closed).toBe(0);
    await second.release();
    await second.release();
    expect(tally.closed).toBe(1);
  });

  test('with no run-end close, a suite on its own still closes what it opened', async () => {
    const leases = createE2eBrowserLeases();
    const { tally, open } = counted();

    await leases.lease('nav', open).release();
    await leases.lease('nav', open).release();

    expect(tally).toEqual({ opened: 2, closed: 2 });
  });

  test('with the run-end close, suites in sequence share one browser, closed once at the end', async () => {
    const leases = createE2eBrowserLeases();
    const { tally, open } = counted();
    const hooks: { run: () => Promise<void>; timeoutMs: number }[] = [];
    const after: RunEndHook = (run, timeoutMs) => hooks.push({ run, timeoutMs });

    leases.closeAtRunEnd(after);
    leases.closeAtRunEnd(after);
    for (const _suite of [1, 2, 3]) {
      const held = leases.lease('nav', open);
      await held.opened;
      await held.release();
    }
    expect(tally).toEqual({ opened: 1, closed: 0 });

    expect(hooks).toHaveLength(1);
    // The hook may await an open still in flight, so it gets an open's deadline, never Bun's 5 s.
    expect(hooks[0]?.timeoutMs).toBe(E2E_BROWSER_OPEN_MS);
    await hooks[0]?.run();
    expect(tally.closed).toBe(1);
  });

  test('a failed open is not shared: the next suite opens afresh and meets its own error', async () => {
    const leases = createE2eBrowserLeases();
    // Kept for the run: the case where a failed open would otherwise be handed to every later suite.
    leases.closeAtRunEnd(() => undefined);
    const { tally, open } = counted();
    let refuse = true;
    const flaky = async (): Promise<E2eBrowser> => {
      if (refuse) {
        refuse = false;
        throw new CdpLaunchFailedError({ executable: '/usr/bin/google-chrome', attempts: [] });
      }
      return open();
    };

    const first = leases.lease('nav', flaky);
    expect(await first.opened.catch((error: unknown) => error)).toBeUltimateError(
      'X_CDP_LAUNCH_FAILED',
    );
    await first.release();
    const second = leases.lease('nav', flaky);
    expect(await second.opened).toBeDefined();
    await second.release();

    expect(tally).toEqual({ opened: 1, closed: 0 });
  });

  test('two keys are two browsers', async () => {
    const leases = createE2eBrowserLeases();
    const { tally, open } = counted();

    const one = leases.lease('nav', open);
    const two = leases.lease('shot', open);
    expect(await one.opened).not.toBe(await two.opened);
    await one.release();
    await two.release();

    expect(tally).toEqual({ opened: 2, closed: 2 });
  });
});
