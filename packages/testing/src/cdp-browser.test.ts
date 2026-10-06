// The two doors, and the one difference between them. The composition itself — launch, connect,
// attach — is proved against a real Chrome by `e2e/cdp-browser.e2e.test.ts`; what belongs here is
// the rule a CI box with no browser depends on.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CDP_TIMEOUT_MS,
  E2E_BROWSER_CLOSE_MS,
  E2E_BROWSER_OPEN_MS,
  E2E_GOTO_MS,
  E2E_TAB_OPEN_MS,
  GOTO_DEADLINES,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
  SESSION_SETUP_DEADLINES,
  TAB_OPEN_DEADLINES,
} from './cdp-browser';
import type { CdpConnection, CdpEventListener, CdpResult } from './cdp-connection';
import { cdpE2eSession } from './cdp-e2e-session';
import {
  CHROME_PATH_ENV,
  LAUNCH_ATTEMPTS,
  LAUNCH_BUDGET_MS,
  LAUNCH_TIMEOUT_MS,
} from './cdp-launch';
import { LAUNCHED_CLOSE_MS } from './cdp-launch-attempt';
import { CLOSE_GRACE_MS } from './cdp-launch-reap';

const NOWHERE = { [CHROME_PATH_ENV]: '/nonexistent/definitely-not-a-browser' };

describe('opening a browser on a machine that has none', () => {
  test('openE2eBrowserIfAvailable answers undefined, so the suite above it SKIPS', async () => {
    expect(await openE2eBrowserIfAvailable({ env: NOWHERE, timeoutMs: 1_000 })).toBeUndefined();
  });

  test('openE2eBrowser refuses by name, for a caller that has already decided it needs one', async () => {
    const thrown = await openE2eBrowser({ env: NOWHERE, timeoutMs: 1_000 }).catch(
      (error: unknown) => error,
    );

    expect((thrown as { code?: string }).code).toBe('X_CDP_BROWSER_MISSING');
  });
});

describe('the open budget a browser hook is given', () => {
  /** Answers every call at once and announces a created tab the way Chrome does: by auto-attach. */
  const fakeBrowser = () => {
    const browserCalls: string[] = [];
    const tabCalls: string[] = [];
    const listeners = new Map<string, CdpEventListener[]>();
    const connection: CdpConnection = {
      send(method, _params, sessionId): Promise<CdpResult> {
        if (sessionId !== undefined) {
          tabCalls.push(method);
          return Promise.resolve({ result: {} });
        }
        browserCalls.push(method);
        if (method !== 'Target.createTarget') return Promise.resolve({ result: {} });
        const targetId = `tab-${String(browserCalls.length)}`;
        queueMicrotask(() => {
          for (const listener of listeners.get('Target.attachedToTarget') ?? []) {
            listener(
              { sessionId: `s-${targetId}`, targetInfo: { type: 'page', targetId } },
              undefined,
            );
          }
        });
        return Promise.resolve({ result: { targetId } });
      },
      once: () => Promise.resolve(true),
      on(method, listener) {
        listeners.set(method, [...(listeners.get(method) ?? []), listener]);
        return () => undefined;
      },
      close: () => undefined,
    };
    return { connection, browserCalls, tabCalls };
  };

  test('counts every sequential deadline the session and a tab spend', async () => {
    const { connection, browserCalls } = fakeBrowser();

    const session = await cdpE2eSession({ connection, loadTimeoutMs: 1_000 });
    expect(browserCalls).toHaveLength(SESSION_SETUP_DEADLINES);

    await session.newTab();
    // One call, then the attach that publishes the tab: a deadline that is a timer, not a call.
    expect(browserCalls.length - SESSION_SETUP_DEADLINES + 1).toBe(TAB_OPEN_DEADLINES);
  });

  test('a goto spends GOTO_DEADLINES sequential calls: the navigate (raced by the load event), then two reads', async () => {
    const { connection, tabCalls } = fakeBrowser();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 1_000 });
    const tab = await session.newTab();
    const before = tabCalls.length;

    await tab.goto('http://localhost:4000/');

    expect(tabCalls.slice(before)).toEqual([
      'Page.navigate',
      ...Array.from({ length: GOTO_DEADLINES - 1 }, () => 'Runtime.evaluate'),
    ]);
    expect(E2E_GOTO_MS).toBe(GOTO_DEADLINES * DEFAULT_CDP_TIMEOUT_MS);
  });

  test('the close budget is the launched browser close, every step of it bounded by a grace', () => {
    expect(E2E_BROWSER_CLOSE_MS).toBe(LAUNCHED_CLOSE_MS);
    // SIGTERM's grace, SIGKILL's, the group reap, the profile's removal.
    expect(LAUNCHED_CLOSE_MS).toBe(4 * CLOSE_GRACE_MS);
  });

  test('holds both starts of the launch, so a hook never ends one before its designed relaunch', () => {
    expect(E2E_BROWSER_OPEN_MS).toBe(
      LAUNCH_BUDGET_MS + SESSION_SETUP_DEADLINES * DEFAULT_CDP_TIMEOUT_MS + E2E_TAB_OPEN_MS,
    );
    expect(LAUNCH_BUDGET_MS).toBeGreaterThan(LAUNCH_ATTEMPTS * LAUNCH_TIMEOUT_MS);
    expect(E2E_TAB_OPEN_MS).toBe(TAB_OPEN_DEADLINES * DEFAULT_CDP_TIMEOUT_MS);
  });
});
