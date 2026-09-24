// One tab, over a fake connection. What this proves that a real browser cannot prove cheaply:
// the exact CDP calls each port method makes, and the two refusals — an expression that threw in
// the page, and a selector nothing matches. Attaching the tab is the session's
// (`cdp-e2e-session.test.ts`).

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpResult } from './cdp-connection';
import type { E2eTab } from './cdp-e2e-page';
import { cdpE2eTab } from './cdp-e2e-page';

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

/** A connection whose answers the test writes, and whose calls it reads back. */
const fakeConnection = (
  answers: Record<string, Record<string, unknown>> = {},
): { connection: CdpConnection; calls: Call[] } => {
  const calls: Call[] = [];
  const connection: CdpConnection = {
    send(method, params = {}, sessionId): Promise<CdpResult> {
      calls.push({ method, params, sessionId });
      const answer =
        method === 'Target.createTarget'
          ? { targetId: 'target-1' }
          : method === 'Target.attachToTarget'
            ? { sessionId: 'session-1' }
            : answers[`${method}:${String(params['expression'] ?? '')}`];
      return Promise.resolve({ result: answer ?? {} });
    },
    once: () => Promise.resolve(true),
    on: () => () => undefined,
    close: () => undefined,
  };
  return { connection, calls };
};

const value = (raw: unknown): Record<string, unknown> => ({ result: { value: raw } });

/** A tab on the fake connection, as the session hands one out. `offline` is recorded, not sent. */
const tabOn = (connection: CdpConnection, offline: boolean[] = []): E2eTab =>
  cdpE2eTab({
    connection,
    sessionId: 'session-1',
    targetId: 'target-1',
    loadTimeoutMs: 100,
    offline: (enabled) => {
      offline.push(enabled);
      return Promise.resolve();
    },
  });

describe('cdpE2eTab', () => {
  test('url() starts at the tab’s own url and follows a navigation', async () => {
    const { connection } = fakeConnection({
      'Runtime.evaluate:location.href': { result: { value: 'http://app.test/feed' } },
    });
    const page = tabOn(connection);

    expect(page.url()).toBe('about:blank');
    await page.goto('http://app.test/feed');

    expect(page.url()).toBe('http://app.test/feed');
  });

  test('the in-page load wait always answers before the CDP call deadline does', async () => {
    // The wait after `Page.navigate` ran its own `setTimeout` for the WHOLE load budget, which is
    // also the connection's per-call deadline — so a page that never fired `load` was reported as
    // "Runtime.evaluate did not answer" (`X_CDP_TIMEOUT`) instead of reaching the assertion after
    // the navigation, which the comment on that wait says is the point of resolving at all.
    const { connection, calls } = fakeConnection();
    await tabOn(connection).goto('http://app.test/slow');

    const wait = calls.find(
      (call) =>
        call.method === 'Runtime.evaluate' && String(call.params['expression']).includes('load'),
    );
    const timer = /setTimeout\(done, (\d+)\)/.exec(String(wait?.params['expression']));
    expect(timer).not.toBeNull();
    expect(Number(timer?.[1])).toBeLessThan(100);
  });

  test('a navigation the browser refuses is reported with the browser’s own errorText', async () => {
    const calls: Call[] = [];
    const connection: CdpConnection = {
      send(method, params = {}, sessionId): Promise<CdpResult> {
        calls.push({ method, params, sessionId });
        if (method === 'Target.createTarget') return Promise.resolve({ result: { targetId: 't' } });
        if (method === 'Target.attachToTarget') {
          return Promise.resolve({ result: { sessionId: 's' } });
        }
        if (method === 'Page.navigate') {
          return Promise.resolve({ result: { errorText: 'net::ERR_CONNECTION_REFUSED' } });
        }
        return Promise.resolve({ result: {} });
      },
      // False, because an unreachable host loads no page and fires no load event — which is the
      // only configuration in which the navigate reply is the thing that answers.
      once: () => Promise.resolve(false),
      on: () => () => undefined,
      close: () => undefined,
    };
    const page = tabOn(connection);

    const thrown = await page.goto('http://nothing.test/').catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    expect((thrown as { cause?: string }).cause).toContain('ERR_CONNECTION_REFUSED');
  });

  test('evaluate returns the page’s value by value', async () => {
    const { connection } = fakeConnection({ 'Runtime.evaluate:document.title': value('Feed') });
    const page = tabOn(connection);

    expect(await page.evaluate('document.title')).toBe('Feed');
  });

  test('an expression that threw in the page is a coded refusal, not an undefined value', async () => {
    const connection: CdpConnection = {
      send(method): Promise<CdpResult> {
        if (method === 'Target.createTarget') return Promise.resolve({ result: { targetId: 't' } });
        if (method === 'Target.attachToTarget') {
          return Promise.resolve({ result: { sessionId: 's' } });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: { exceptionDetails: { text: 'ReferenceError: nope is not defined' } },
          });
        }
        return Promise.resolve({ result: {} });
      },
      once: () => Promise.resolve(true),
      on: () => () => undefined,
      close: () => undefined,
    };
    const page = tabOn(connection);

    const thrown = await page.evaluate('nope').catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    expect((thrown as { cause?: string }).cause).toContain('nope is not defined');
  });

  test('click refuses a selector the page has no element for', async () => {
    const { connection } = fakeConnection();
    const page = tabOn(connection);

    const thrown = await page.click('#missing').catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    expect((thrown as { cause?: string }).cause).toContain('no element');
  });

  test('offline() is the session’s switch, forwarded — never a page-only condition', async () => {
    const { connection } = fakeConnection();
    const recorded: boolean[] = [];
    const page = tabOn(connection, recorded);

    await page.offline(true);
    await page.offline(false);

    expect(recorded).toEqual([true, false]);
  });

  test('waitFor refuses by name when the expression never holds', async () => {
    const { connection } = fakeConnection({
      'Runtime.evaluate:Boolean(window.ready)': value(false),
    });
    const thrown = await tabOn(connection)
      .waitFor('window.ready', 'the ready flag', 150)
      .catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_TIMEOUT');
    expect((thrown as { cause?: string }).cause).toContain('the ready flag');
  });

  test('waitFor keeps polling through a document that throws mid-navigation', async () => {
    // A click that navigates leaves the poll reading a document whose `<body>` has not been parsed
    // yet: `document.body.textContent` throws there, the evaluate came back as `Uncaught`, and the
    // wait refused as X_CDP_CALL_FAILED although the very next poll would have held.
    let polls = 0;
    const connection: CdpConnection = {
      send(): Promise<CdpResult> {
        polls += 1;
        return Promise.resolve({
          result:
            polls === 1 ? { exceptionDetails: { text: 'Uncaught' } } : { result: { value: true } },
        });
      },
      once: () => Promise.resolve(true),
      on: () => () => undefined,
      close: () => undefined,
    };

    await tabOn(connection).waitFor('document.body.textContent', 'the page', 1_000);
    expect(polls).toBe(2);
  });

  test('a waitFor whose expression ALWAYS throws still refuses, naming what it threw', async () => {
    const connection: CdpConnection = {
      send: () =>
        Promise.resolve({ result: { exceptionDetails: { text: 'ReferenceError: nope' } } }),
      once: () => Promise.resolve(true),
      on: () => () => undefined,
      close: () => undefined,
    };
    const thrown = await tabOn(connection)
      .waitFor('nope', 'the flag', 150)
      .catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_TIMEOUT');
    expect((thrown as { cause?: string }).cause).toContain('ReferenceError: nope');
  });

  test('indexedDbNames answers the page’s own list, and [] for anything else', async () => {
    const listing =
      '(async () => (await indexedDB.databases()).map((db) => db.name ?? "").sort())()';
    const { connection } = fakeConnection({ [`Runtime.evaluate:${listing}`]: value(['a', 'b']) });
    expect(await tabOn(connection).indexedDbNames()).toEqual(['a', 'b']);
    expect(await tabOn(fakeConnection().connection).indexedDbNames()).toEqual([]);
  });
});
