// The launch fixture's handshake, over a fake connection: the browser endpoint answered (the
// launch's own first call), and the page it was handed EXISTS — heard as `Target.targetCreated`,
// never polled for on a clock. And the test deadline is the launch's designed budget, derived.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpTransport } from './cdp-connection';
import { cdpConnectOver } from './cdp-connection';
import { LAUNCH_ATTEMPTS, LAUNCH_BUDGET_MS, LAUNCH_TIMEOUT_MS } from './cdp-launch';
import { LAUNCH_REAP_MS, LAUNCHED_CLOSE_MS } from './cdp-launch-attempt';
import { LAUNCH_TEST_MS, launchTestMs, pageTargetReady } from './cdp-launch-ready';

interface FakeBrowser {
  readonly connection: CdpConnection;
  readonly sent: string[];
  /** Announce a target, as Chrome does once discovery is on — and later, for one that starts late. */
  created(type: string, url: string): void;
}

/**
 * The REAL connection (`cdpConnectOver`) over a stub transport whose browser announces `existing`
 * the moment discovery is switched on — and, with `dies`, hangs up right after answering that call.
 */
function fakeBrowser(
  existing: readonly { type: string; url: string }[],
  dies = false,
  silentAfterOn = false,
): FakeBrowser {
  const sent: string[] = [];
  let handlers: { message(text: string): void; closed(reason: string): void } | undefined;
  const created = (type: string, url: string): void => {
    handlers?.message(
      JSON.stringify({
        method: 'Target.targetCreated',
        params: { targetInfo: { type, url, targetId: `${type}-${url}` } },
      }),
    );
  };
  const transport: CdpTransport = {
    listen(installed) {
      handlers = installed;
    },
    close: () => undefined,
    send(text) {
      const frame = JSON.parse(text) as { id: number; method: string; params?: unknown };
      sent.push(`${frame.method} ${JSON.stringify(frame.params ?? {})}`);
      queueMicrotask(() => {
        const on = (frame.params as { discover?: unknown } | undefined)?.discover === true;
        // A browser gone silent once discovery is on: nothing after it is ever answered.
        if (silentAfterOn && !on) return;
        handlers?.message(JSON.stringify({ id: frame.id, result: {} }));
        if (frame.method !== 'Target.setDiscoverTargets' || !on) return;
        // Chrome answers the call, then sends one `targetCreated` per target that already exists.
        for (const target of existing) created(target.type, target.url);
        if (dies) handlers?.closed('the browser exited');
      });
    },
  };
  return { connection: cdpConnectOver(transport, 1_000), sent, created };
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

  test('a browser gone silent costs the deadline once: switching discovery off is bounded by what is left', async () => {
    const browser = fakeBrowser([{ type: 'browser', url: '' }], false, true);
    const started = performance.now();

    const error = await pageTargetReady(browser.connection, 300).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_CDP_TIMEOUT');
    // A fresh deadline for the off-switch made this 600 ms: two deadlines, past `launchTestMs`.
    expect(performance.now() - started).toBeLessThan(450);
  });

  test('a browser that dies mid-wait is X_CDP_CALL_FAILED at once, never a deadline spent spinning', async () => {
    const browser = fakeBrowser([{ type: 'browser', url: '' }], true);
    const started = performance.now();

    const error = await pageTargetReady(browser.connection, 5_000).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_CDP_CALL_FAILED');
    expect((error as { cause: string }).cause).toContain(
      'closed while waiting for the page target',
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('launchTestMs — a test that awaits a launch outlives the launch', () => {
  test('the worst path fits: every start and its reap, the handshake, then the close', () => {
    // A browser that started and then went silent: both starts as long as allowed, the handshake
    // its whole deadline (the off-switch takes what is left of it), then `launchReady` closes it.
    const worst = (ms: number): number =>
      LAUNCH_ATTEMPTS * (ms + LAUNCH_REAP_MS) + ms + LAUNCHED_CLOSE_MS;
    for (const ms of [300, 5_000, LAUNCH_TIMEOUT_MS]) {
      expect(launchTestMs(ms)).toBeGreaterThan(worst(ms));
    }
    expect(LAUNCH_TEST_MS).toBe(launchTestMs(LAUNCH_TIMEOUT_MS));
    expect(LAUNCH_TEST_MS).toBeGreaterThan(LAUNCH_BUDGET_MS);
  });
});
