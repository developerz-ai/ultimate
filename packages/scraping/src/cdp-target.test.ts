// The real driver's target, over a hand-built CDP page. Three things only this file can see:
// WHEN a restored session's `localStorage` is written, what a network entry says the method was,
// and what a console line says its level was — all three are read straight off the library's own
// event payloads, so the offline drivers cannot pin any of them.

import { describe, expect, test } from 'bun:test';
import type { CdpBrowserLike, CdpPageLike } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import type { SessionSnapshot } from './session-state';

interface Recorder {
  readonly page: CdpPageLike;
  readonly browser: CdpBrowserLike;
  /** Every `evaluate` expression and `goto`, in order, so ORDER is what the test asserts on. */
  readonly calls: readonly string[];
  emit(event: string, payload: unknown): void;
}

const recorder = (start = 'about:blank'): Recorder => {
  const calls: string[] = [];
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  let url = start;
  const page: CdpPageLike = {
    url: () => url,
    goto: (next: string) => {
      calls.push(`goto ${next}`);
      url = next;
      return Promise.resolve(undefined);
    },
    content: () => Promise.resolve(''),
    evaluate: (expression: string) => {
      calls.push(`evaluate ${expression}`);
      return Promise.resolve(undefined);
    },
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    select: () => Promise.resolve([]),
    screenshot: () => Promise.resolve(new Uint8Array()),
    pdf: () => Promise.resolve(new Uint8Array()),
    setRequestInterception: () => Promise.resolve(),
    on: (event: string, handler: (payload: unknown) => void) => {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
      return undefined;
    },
    frames: () => [],
    close: () => Promise.resolve(),
  };
  return {
    page,
    browser: {
      newPage: () => Promise.resolve(page),
      setCookie: () => Promise.resolve(),
      close: () => Promise.resolve(),
      process: () => null,
    },
    calls,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
};

const SESSION: SessionSnapshot = {
  cookies: [
    { name: 'sid', value: 'x', domain: 'shop.test', path: '/', httpOnly: true, secure: true },
  ],
  headers: {},
  storage: { token: 'bearer-abc' },
  userAgent: 'agent',
  origin: 'https://shop.test',
};

const open = (start?: string) => {
  const rec = recorder(start);
  return {
    rec,
    target: cdpTarget({
      page: rec.page,
      browser: rec.browser,
      rules: { allowHosts: ['*'] },
      clock: testClock(),
    }),
  };
};

const storageWrites = (calls: readonly string[]): readonly string[] =>
  calls.filter((call) => call.includes('setItem'));

describe('unit · restored localStorage lands on the session ORIGIN, never on about:blank', () => {
  test('restore() before the first navigation writes no storage — an opaque origin has none', async () => {
    const { rec, target } = open();
    await (await target).restore(SESSION);
    expect(storageWrites(rec.calls)).toEqual([]);
  });

  test('it lands on the first navigation to the origin the session belongs to', async () => {
    const { rec, target } = open();
    const page = await target;
    await page.restore(SESSION);
    await page.goto('https://shop.test/orders', { timeoutMs: 1_000 });
    expect(storageWrites(rec.calls)).toHaveLength(1);
    expect(rec.calls.indexOf('goto https://shop.test/orders')).toBeLessThan(
      rec.calls.findIndex((call) => call.includes('setItem')),
    );
  });

  test('and never on another origin — a bearer token is not handed to a site it is not for', async () => {
    const { rec, target } = open();
    const page = await target;
    await page.restore(SESSION);
    await page.goto('https://other.test/', { timeoutMs: 1_000 });
    expect(storageWrites(rec.calls)).toEqual([]);
    // Still pending: the run that finally reaches the site gets its session.
    await page.goto('https://shop.test/orders', { timeoutMs: 1_000 });
    expect(storageWrites(rec.calls)).toHaveLength(1);
  });

  test('it is written once, not on every navigation', async () => {
    const { rec, target } = open();
    const page = await target;
    await page.restore(SESSION);
    await page.goto('https://shop.test/a', { timeoutMs: 1_000 });
    await page.goto('https://shop.test/b', { timeoutMs: 1_000 });
    expect(storageWrites(rec.calls)).toHaveLength(1);
  });
});

describe('unit · a network entry says what the request actually was', () => {
  // RECEIVER-DEPENDENT on purpose. puppeteer's `HTTPRequest.method()` reads the request's own
  // internals, so a fake that closed over a constant would answer the same whether the framework
  // called `request.method()` or handed the bare function to a helper — and the second one is
  // `undefined` against the real library. `DETACHED` is what a lost `this` looks like here.
  const request = (url: string, method: string | undefined) => {
    const base = {
      url: () => url,
      resourceType: () => 'fetch',
      abort: () => Promise.resolve(),
      continue: () => Promise.resolve(),
    };
    return method === undefined
      ? base
      : {
          ...base,
          verb: method,
          method(this: { readonly verb?: string } | undefined): string {
            return typeof this?.verb === 'string' ? this.verb : 'DETACHED';
          },
        };
  };

  test('a POST is recorded as a POST — page.network() is what X_SCRAPE_HTTP_FAILED points at', async () => {
    const { rec, target } = open();
    const page = await target;
    rec.emit('request', request('https://shop.test/api', 'POST'));
    expect(page.network.entries().map((entry) => entry.method)).toEqual(['POST']);
  });

  test('a refused request keeps its method too — a blocked POST is not a blocked GET', async () => {
    const rec = recorder();
    const page = await cdpTarget({
      page: rec.page,
      browser: rec.browser,
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
    });
    rec.emit('request', request('https://evil.test/api', 'PUT'));
    expect(page.network.entries().map((entry) => [entry.method, entry.refused])).toEqual([
      ['PUT', 'host'],
    ]);
  });

  test('a launcher whose request has no method() still records one', async () => {
    const { rec, target } = open();
    const page = await target;
    rec.emit('request', request('https://shop.test/api', undefined));
    expect(page.network.entries().map((entry) => entry.method)).toEqual(['GET']);
  });
});

describe('unit · a console line keeps its level', () => {
  // Same rule as the request fake: `ConsoleMessage.type()` and `.text()` read `this`, so these
  // answer out of the payload rather than out of a closure.
  const message = (level: string) => ({
    level,
    type(this: { readonly level?: string } | undefined): string {
      return typeof this?.level === 'string' ? this.level : 'DETACHED';
    },
    text(this: { readonly level?: string } | undefined): string {
      return typeof this?.level === 'string' ? `a ${this.level}` : 'DETACHED';
    },
  });

  test('the four levels below log are reachable on the real driver', async () => {
    const { rec, target } = open();
    const page = await target;
    for (const type of ['error', 'warning', 'info', 'debug', 'table'])
      rec.emit('console', message(type));
    expect(page.console.entries().map((line) => line.level)).toEqual([
      'error',
      'warn',
      'info',
      'debug',
      'log',
    ]);
  });

  test('and its text — an accessor is called THROUGH the message, not bare', async () => {
    const { rec, target } = open();
    const page = await target;
    rec.emit('console', message('warning'));
    expect(page.console.entries().map((line) => line.text)).toEqual(['a warning']);
  });
});
