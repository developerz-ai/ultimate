// The launch fixture's handshake, over a fake connection: the browser endpoint answered (the
// launch's own first call), and the page it was handed EXISTS — heard as `Target.targetCreated`,
// never polled for on a clock. And the test deadline is the launch's designed budget, derived.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpEventListener, CdpResult } from './cdp-connection';
import { LAUNCH_ATTEMPTS, LAUNCH_BUDGET_MS, LAUNCH_TIMEOUT_MS } from './cdp-launch';
import { LAUNCH_REAP_MS } from './cdp-launch-attempt';
import { LAUNCH_TEST_MS, launchTestMs, pageTargetReady } from './cdp-launch-ready';

interface FakeBrowser {
  readonly connection: CdpConnection;
  readonly sent: string[];
  /** Announce a target, as Chrome does once discovery is on — and later, for one that starts late. */
  created(type: string, url: string): void;
}

/** A connection whose browser announces `existing` the moment discovery is switched on. */
function fakeBrowser(existing: readonly { type: string; url: string }[]): FakeBrowser {
  const listeners = new Map<string, Set<CdpEventListener>>();
  const sent: string[] = [];
  const created = (type: string, url: string): void => {
    for (const listener of listeners.get('Target.targetCreated') ?? []) {
      listener({ targetInfo: { type, url, targetId: `${type}-${url}` } }, undefined);
    }
  };
  const connection: CdpConnection = {
    async send(method, params): Promise<CdpResult> {
      sent.push(`${method} ${JSON.stringify(params ?? {})}`);
      if (method === 'Target.setDiscoverTargets' && params?.['discover'] === true) {
        // Chrome answers the call, then sends one `targetCreated` per target that already exists.
        queueMicrotask(() => {
          for (const target of existing) created(target.type, target.url);
        });
      }
      return { result: {} };
    },
    once: async () => false,
    on(method, listener) {
      const set = listeners.get(method) ?? new Set<CdpEventListener>();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    close: () => undefined,
  };
  return { connection, sent, created };
}

describe('pageTargetReady — the page the browser was handed exists', () => {
  test('answers once a page target is announced, then switches discovery back off', async () => {
    const browser = fakeBrowser([
      { type: 'browser', url: '' },
      { type: 'page', url: 'about:blank' },
    ]);

    await pageTargetReady(browser.connection, 1_000);

    expect(browser.sent).toEqual([
      'Target.setDiscoverTargets {"discover":true}',
      'Target.setDiscoverTargets {"discover":false}',
    ]);
  });

  test('a page that starts AFTER the endpoint answered is waited for, not missed', async () => {
    const browser = fakeBrowser([{ type: 'browser', url: '' }]);
    let ready = false;
    const waiting = pageTargetReady(browser.connection, 1_000).then(() => {
      ready = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);

    browser.created('page', 'about:blank');
    await waiting;

    expect(ready).toBe(true);
  });

  test('no page inside the deadline is X_CDP_TIMEOUT naming the handshake', async () => {
    const browser = fakeBrowser([{ type: 'service_worker', url: 'chrome-extension://x/bg.js' }]);

    const error = await pageTargetReady(browser.connection, 20).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_CDP_TIMEOUT');
    expect((error as { cause: string }).cause).toContain('Target.targetCreated');
    expect(browser.sent.at(-1)).toBe('Target.setDiscoverTargets {"discover":false}');
  });
});

describe('launchTestMs — a test that awaits a launch outlives the launch', () => {
  test('every start its deadline and its reap, and the handshake after the last', () => {
    expect(launchTestMs(300)).toBe(LAUNCH_ATTEMPTS * (300 + LAUNCH_REAP_MS) + 2 * 300);
    expect(LAUNCH_TEST_MS).toBe(launchTestMs(LAUNCH_TIMEOUT_MS));
    expect(LAUNCH_TEST_MS).toBeGreaterThan(LAUNCH_BUDGET_MS);
  });
});
