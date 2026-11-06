// The browser half's edges, over the fake connection: a tab the browser never attaches is refused
// at the load deadline rather than awaited forever, a cookie is set browser-wide on the URL given,
// an init script a closed tab refuses drops that tab instead of failing the call, a page that never
// applies the cut is a bounded timeout, and a tab gone by the switch is dropped from it.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection } from './cdp-connection';
import { cdpE2eSession } from './cdp-e2e-session';
import { fake } from './cdp-e2e-session-fake-fixture';
import { NETWORK_PROBE } from './cdp-network-probe';

/** The fake, with `refuse` deciding which calls — still recorded — are answered by a rejection. */
const refusing = (
  connection: CdpConnection,
  refuse: (method: string, sessionId: string | undefined) => boolean,
): CdpConnection => ({
  ...connection,
  send: (method, params, sessionId, deadlineMs) =>
    connection
      .send(method, params, sessionId, deadlineMs)
      .then((answer) =>
        refuse(method, sessionId) ? Promise.reject(new TypeError(`refused ${method}`)) : answer,
      ),
});

describe('cdpE2eSession edges', () => {
  test('a tab the browser never attaches is X_CDP_TIMEOUT at the load deadline', async () => {
    const { connection } = fake();
    // Answers the create, swallows the auto-attach that would have published the tab.
    const silent: CdpConnection = {
      ...connection,
      on: (method, listener) =>
        method === 'Target.attachedToTarget' ? () => undefined : connection.on(method, listener),
    };
    const session = await cdpE2eSession({ connection: silent, loadTimeoutMs: 20 });
    let refused: unknown;
    try {
      await session.newTab();
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: 'X_CDP_TIMEOUT' });
    expect(String((refused as Error).message)).toContain('Target.attachedToTarget for tab tab-1');
  });

  test('setCookie sets it browser-wide, on the URL, at the root path', async () => {
    const { connection, calls } = fake();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
    await session.setCookie('http://app.test/', 'sid', 'abc');
    const set = calls.find((call) => call.method === 'Storage.setCookies');
    expect(set?.sessionId).toBeUndefined();
    expect(set?.params).toEqual({
      cookies: [{ name: 'sid', value: 'abc', url: 'http://app.test/', path: '/' }],
    });
  });

  test('an init script a closed tab refuses drops that tab, and the next script skips it', async () => {
    const { connection, calls } = fake();
    let closed = false;
    const session = await cdpE2eSession({
      connection: refusing(
        connection,
        (method, sessionId) =>
          closed &&
          sessionId === 'tab-session' &&
          method === 'Page.addScriptToEvaluateOnNewDocument',
      ),
      loadTimeoutMs: 500,
    });
    await session.newTab();
    closed = true;
    await session.addInitScript('window.__one = true;');
    await session.addInitScript('window.__two = true;');
    const sent = calls
      .filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
      .map((call) => [call.sessionId, call.params['source']]);
    expect(sent).toEqual([['tab-session', 'window.__one = true;']]);
  });

  test('a page that never reads the cut is X_CDP_TIMEOUT naming navigator.onLine, bounded', async () => {
    const { connection, calls } = fake({ lag: 'never' });
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 50 });
    await session.newTab();
    let thrown: unknown;
    try {
      await session.offline(true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'X_CDP_TIMEOUT' });
    expect(String((thrown as { cause?: string }).cause)).toContain('navigator.onLine === false');
    // The page never read the state, so no request was sent to prove the network agrees.
    const probes = calls.filter((call) => call.params['expression'] === NETWORK_PROBE);
    expect(probes).toEqual([]);
  });

  test('a tab gone by the switch is dropped from it, and the switch still lands', async () => {
    const { connection, calls } = fake();
    let gone = false;
    const session = await cdpE2eSession({
      connection: refusing(
        connection,
        (method, sessionId) =>
          gone && sessionId === 'tab-session' && method === 'Network.emulateNetworkConditions',
      ),
      loadTimeoutMs: 500,
    });
    await session.newTab();
    gone = true;
    await session.offline(true);
    const asked = calls.filter((call) => call.sessionId === 'tab-session').length;
    await session.offline(false);
    // Dropped: the second switch sends the gone tab nothing at all.
    expect(calls.filter((call) => call.sessionId === 'tab-session')).toHaveLength(asked);
  });
});
