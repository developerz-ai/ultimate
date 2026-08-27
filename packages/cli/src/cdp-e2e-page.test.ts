// The page, over a fake connection. What this proves that a real browser cannot prove cheaply:
// the exact CDP calls each port method makes, and the two refusals — an expression that threw in
// the page, and a selector nothing matches.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpResult } from './cdp-connection';
import { cdpE2ePage } from './cdp-e2e-page';

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

describe('cdpE2ePage', () => {
  test('attaches flattened, and enables the three domains every method below needs', async () => {
    const { connection, calls } = fakeConnection();

    await cdpE2ePage({ connection, loadTimeoutMs: 100 });

    expect(calls.map((call) => call.method)).toEqual([
      'Target.createTarget',
      'Target.attachToTarget',
      'Page.enable',
      'Runtime.enable',
      'Network.enable',
      // A SERVICE WORKER fetches on its own target: without this, `offline()` set the condition on
      // the page's session alone and the worker kept answering from the network, which made every
      // offline assertion on a PWA read as proof of something that had not happened.
      'Target.setAutoAttach',
    ]);
    expect(calls[1]?.params['flatten']).toBe(true);
    // Every page call carries the session, or it addresses the BROWSER and silently does nothing
    // to the tab under test.
    expect(calls.slice(2).map((call) => call.sessionId)).toEqual([
      'session-1',
      'session-1',
      'session-1',
      'session-1',
    ]);
    expect(calls[5]?.params).toEqual({
      autoAttach: true,
      // `false`, or every worker starts PAUSED and the page that registered it never becomes
      // controlled — which is the whole subject of the suite that drives a real one.
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  });

  test('url() starts at the tab’s own url and follows a navigation', async () => {
    const { connection } = fakeConnection({
      'Runtime.evaluate:location.href': { result: { value: 'http://app.test/feed' } },
    });
    const page = await cdpE2ePage({ connection, loadTimeoutMs: 100 });

    expect(page.url()).toBe('about:blank');
    await page.goto('http://app.test/feed');

    expect(page.url()).toBe('http://app.test/feed');
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
    const page = await cdpE2ePage({ connection, loadTimeoutMs: 100 });

    const thrown = await page.goto('http://nothing.test/').catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    expect((thrown as { cause?: string }).cause).toContain('ERR_CONNECTION_REFUSED');
  });

  test('evaluate returns the page’s value by value', async () => {
    const { connection } = fakeConnection({ 'Runtime.evaluate:document.title': value('Feed') });
    const page = await cdpE2ePage({ connection, loadTimeoutMs: 100 });

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
    const page = await cdpE2ePage({ connection, loadTimeoutMs: 100 });

    const thrown = await page.evaluate('nope').catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    expect((thrown as { cause?: string }).cause).toContain('nope is not defined');
  });

  test('click refuses a selector the page has no element for', async () => {
    const { connection } = fakeConnection();
    const page = await cdpE2ePage({ connection, loadTimeoutMs: 100 });

    const thrown = await page.click('#missing').catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    expect((thrown as { cause?: string }).cause).toContain('no element');
  });

  test('offline() sets both throughputs to -1, which is CDP’s “no throttling”', async () => {
    const { connection, calls } = fakeConnection();
    const page = await cdpE2ePage({ connection, loadTimeoutMs: 100 });

    await page.offline?.(true);

    const emulate = calls.find((call) => call.method === 'Network.emulateNetworkConditions');
    expect(emulate?.params).toEqual({
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    expect(emulate?.sessionId).toBe('session-1');
  });
});
