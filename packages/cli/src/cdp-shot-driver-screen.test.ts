import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpEventListener } from '@ultimat3/scraping/cdp';
import { screenedConnection } from './cdp-shot-driver-screen';

/** A connection that records sends and lets the test fire events. */
function fakeConnection() {
  const listeners = new Map<string, CdpEventListener[]>();
  const sent: {
    method: string;
    params: Record<string, unknown> | undefined;
    on: string | undefined;
  }[] = [];
  const connection: CdpConnection = {
    send: async (method, params, sessionId) => {
      sent.push({ method, params, on: sessionId });
      return { result: {} } as Awaited<ReturnType<CdpConnection['send']>>;
    },
    once: () => Promise.resolve(true),
    on: (method, listener) => {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
      return () => undefined;
    },
    close: () => undefined,
  };
  const fire = (method: string, params: Record<string, unknown>, on: string | undefined) => {
    for (const listener of listeners.get(method) ?? []) listener(params, on);
  };
  return { connection, sent, fire };
}

const paused = (url: string) => ({ requestId: 'r1', request: { url, method: 'GET' } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('screenedConnection', () => {
  test('a request the screen refuses is failed on its own session and never reaches the watch', async () => {
    const { connection, sent, fire } = fakeConnection();
    const refused: string[] = [];
    const seen: string[] = [];
    const screened = screenedConnection(connection, {
      owns: (on) => on === 'page',
      screen: (url) => (url.includes('inward') ? Promise.resolve('private' as const) : undefined),
      refused: (url, reason) => refused.push(`${reason} ${url}`),
    });
    screened.on('Fetch.requestPaused', (params) => seen.push(String(params['requestId'])));
    fire('Fetch.requestPaused', paused('http://inward.test/'), 'page');
    await tick();
    expect(seen).toEqual([]);
    expect(refused).toEqual(['private http://inward.test/']);
    expect(sent).toEqual([
      {
        method: 'Fetch.failRequest',
        params: { requestId: 'r1', errorReason: 'BlockedByClient' },
        on: 'page',
      },
    ]);
  });

  test('a request with nothing to resolve, or resolved public, is handed to the watch', async () => {
    const { connection, sent, fire } = fakeConnection();
    const seen: string[] = [];
    const screened = screenedConnection(connection, {
      owns: () => true,
      screen: (url) => (url.includes('public') ? Promise.resolve(undefined) : undefined),
      refused: () => undefined,
    });
    screened.on('Fetch.requestPaused', (params) => seen.push(String(params['requestId'])));
    fire('Fetch.requestPaused', paused('http://1.2.3.4/'), 'page');
    fire('Fetch.requestPaused', paused('http://public.test/'), 'page');
    await tick();
    expect(seen).toEqual(['r1', 'r1']);
    expect(sent).toEqual([]);
  });

  test('a screen that throws refuses as unresolved: failing closed, never called private', async () => {
    const { connection, sent, fire } = fakeConnection();
    const reasons: string[] = [];
    const screened = screenedConnection(connection, {
      owns: () => true,
      screen: () => Promise.reject(new TypeError('resolver down')),
      refused: (_url, reason) => reasons.push(reason),
    });
    screened.on('Fetch.requestPaused', () =>
      expect.unreachable('a refused request reached the watch'),
    );
    fire('Fetch.requestPaused', paused('http://any.test/'), 'page');
    await tick();
    expect(sent.map((call) => call.method)).toEqual(['Fetch.failRequest']);
    expect(reasons).toEqual(['unresolved']);
  });

  test("another session's pause and every other event pass through untouched", async () => {
    const { connection, fire } = fakeConnection();
    const seen: string[] = [];
    const screened = screenedConnection(connection, {
      owns: (on) => on === 'page',
      screen: () => Promise.resolve('private' as const),
      refused: () => undefined,
    });
    screened.on('Fetch.requestPaused', (_params, on) => seen.push(`paused:${String(on)}`));
    screened.on('Network.requestWillBeSent', () => seen.push('sent'));
    fire('Fetch.requestPaused', paused('http://x.test/'), 'someone-else');
    fire('Network.requestWillBeSent', {}, 'page');
    await tick();
    expect(seen).toEqual(['paused:someone-else', 'sent']);
  });
});
