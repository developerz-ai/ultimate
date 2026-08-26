// The real driver's target, over a hand-built CDP page. Three things only this file can see:
// WHEN a restored session's `localStorage` is written, what a network entry says the method was,
// and what a console line says its level was — all three are read straight off the library's own
// event payloads, so the offline drivers cannot pin any of them.

import { describe, expect, test } from 'bun:test';
import type { CdpBrowserLike, CdpPageLike } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import { DEFAULT_RING_CAPACITY } from './rings';
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
    // The whole recorded sequence, not a pairwise `indexOf`: a navigation that stopped being made
    // at all answers -1, which is less than every real index, so "the goto came first" read as
    // satisfied for a page that never left about:blank.
    expect(rec.calls).toEqual([
      'goto https://shop.test/orders',
      expect.stringContaining('localStorage.setItem'),
    ]);
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

  /**
   * `type` is a string off the WIRE, so `CONSOLE_LEVELS[type]` read the prototype chain:
   * `__proto__` answered `Object.prototype` and `constructor` the `Object` function, neither of
   * which `?? 'log'` can rescue. `ConsoleLine.level` then held a value its own type says is one of
   * five words — so `entries().filter((l) => l.level === 'error')`, which is the only reason this
   * ring exists, silently matched nothing, and `JSON.stringify` dropped the field from a session
   * snapshot entirely. Same discriminator as `packages/flags/src/subject.ts`.
   */
  test('a level naming an Object.prototype member falls back to log, never to a function', async () => {
    const { rec, target } = open();
    const page = await target;
    for (const type of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'])
      rec.emit('console', message(type));
    const levels = page.console.entries().map((line) => line.level);
    expect(levels).toEqual(['log', 'log', 'log', 'log', 'log']);
    for (const level of levels) expect(typeof level).toBe('string');
  });
});

describe('unit · an uncaught page exception is recorded, and is NOT a console line', () => {
  /**
   * The gap this closes: an island that throws during hydration leaves a screenshot that is a
   * picture of the server-rendered markup — identical to the one a working page produces. The
   * page called no console method, so `console()` is empty for it, and until this ring existed
   * nothing in the package subscribed to `pageerror` at all.
   *
   * The `new Error` below is INPUT — the payload puppeteer hands the handler — never this test
   * reporting its own verdict, which is `expect.unreachable`'s job.
   */
  const thrown = (): Error => {
    const error = new TypeError('cart.items is undefined');
    error.stack =
      'TypeError: cart.items is undefined\n    at Cart (/app/islands/cart.tsx:31:18)\n    at hydrate';
    return error;
  };

  test('it lands in pageErrors, with the stack that names the island', async () => {
    const { rec, target } = open();
    const page = await target;
    rec.emit('pageerror', thrown());
    const errors = page.pageErrors.entries();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('cart.items is undefined');
    expect(errors[0]?.stack).toContain('islands/cart.tsx:31:18');
  });

  test('and it never leaks into console() — two streams, because they are two events', async () => {
    const { rec, target } = open();
    const page = await target;
    rec.emit('pageerror', thrown());
    // A `console.error` that the page never made would send an author reading the console tail
    // looking for a log line that does not exist.
    expect(page.console.entries()).toEqual([]);
  });

  test('the session stays USABLE — a throw in the page is not a dead renderer', async () => {
    // `pageerror` and `error` are different puppeteer events (`PageEvent.PageError` is "an
    // uncaught exception happens within the page"; `PageEvent.Error` is "the page crashes").
    // Latching the first as a crash would answer X_SCRAPE_PAGE_CRASHED — registered `terminal`,
    // so dead-lettered without a retry — for a page that still renders and still clicks.
    const { rec, target } = open();
    const page = await target;
    rec.emit('pageerror', thrown());
    await expect(page.content()).resolves.toBe('');
    expect(page.pageErrors.entries()).toHaveLength(1);
  });

  test('a page that threw a STRING, or an object with no message, is still recorded', async () => {
    // Not every uncaught value is an `Error`: `throw 'nope'` is legal in a page, and an entry with
    // a poor message is still the difference between "the island threw" and silence.
    const { rec, target } = open();
    const page = await target;
    rec.emit('pageerror', 'nope');
    rec.emit('pageerror', { detail: 'no message here' });
    expect(page.pageErrors.entries().map((error) => error.message)).toEqual(['nope', '']);
    expect(page.pageErrors.entries().map((error) => error.stack)).toEqual([undefined, undefined]);
  });

  test('the ring is BOUNDED and honest — a rAF loop that throws cannot eat the heap', async () => {
    // At `DEFAULT_RING_CAPACITY` and not at a `ringCapacity` this test passes in: that option was
    // declared on `CdpTargetInit`, read here, and passed by no production caller at any distance —
    // a knob only a test could turn. The bound is the framework's one bound, so the test exercises
    // the one an app actually gets.
    const rec = recorder();
    const page = await cdpTarget({
      page: rec.page,
      browser: rec.browser,
      rules: { allowHosts: ['*'] },
      clock: testClock(),
    });
    const overflow = DEFAULT_RING_CAPACITY + 2;
    for (let index = 1; index <= overflow; index += 1) {
      rec.emit('pageerror', new Error(`boom ${String(index)}`));
    }
    const messages = page.pageErrors.entries().map((error) => error.message);
    expect(messages).toHaveLength(DEFAULT_RING_CAPACITY);
    expect(messages.at(-1)).toBe(`boom ${String(overflow)}`);
    expect(page.pageErrors.dropped).toBe(2);
  });
});

/**
 * A page attribute and a storage key are the BROWSER's data, not an untrusted request body — and
 * `t.record()` refuses `__proto__`, `constructor` and `prototype` by name, which is the right
 * answer for a request body and the wrong one here.
 *
 * `<div constructor="Foo">` is legal HTML that a framework's own build emits, and
 * `localStorage.setItem('constructor', …)` is legal storage. Both threw `X_VALIDATION_FAILED` out
 * of `parseSnapshots`/`storageSchema` — inside `guard()`, which re-labelled it
 * `X_SCRAPE_BROWSER_UNREACHABLE`, a code registered RETRYABLE. Five browser launches and five
 * arrivals at a login, and a dead letter saying the browser went away about a browser that
 * answered perfectly. The offline drivers build `attrs` in JS and never parse, so
 * `driver-parity.test.ts` cannot see it.
 */
describe('unit · the browser`s own keys are read, never refused by name', () => {
  const answering = (answers: Readonly<Record<string, unknown>>): Recorder => {
    const base = recorder('https://shop.test/o');
    return {
      ...base,
      page: {
        ...base.page,
        evaluate: (expression: string) => {
          for (const [needle, answer] of Object.entries(answers)) {
            if (expression.includes(needle)) return Promise.resolve(answer);
          }
          return Promise.resolve(undefined);
        },
      },
    };
  };

  test('an element carrying a `constructor` attribute is a snapshot, not a refusal', async () => {
    const snapshot = [
      {
        tag: 'div',
        attrs: { constructor: 'Foo', __proto__: 'x', id: 'row' },
        text: 'one',
        value: '',
        visible: true,
        enabled: true,
        box: { x: 0, y: 0, width: 1, height: 1 },
        hitTarget: true,
      },
    ];
    const cdp = answering({ querySelectorAll: JSON.stringify(snapshot) });
    const target = await cdpTarget({
      page: cdp.page,
      browser: cdp.browser,
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
    });
    const [element] = await target.query('.row');
    expect(element?.attrs['constructor']).toBe('Foo');
    // Read back off a NULL prototype, so an attribute the page never carried answers `undefined`
    // rather than a function: `attrs['toString']` was the `Object.prototype` method.
    expect(element?.attrs['toString']).toBeUndefined();
  });

  test('a localStorage key named `constructor` is a session, not a refusal', async () => {
    const cdp = answering({
      localStorage: JSON.stringify({ constructor: 'v', token: 'bearer-abc' }),
      'navigator.userAgent': 'agent',
    });
    const target = await cdpTarget({
      page: cdp.page,
      browser: cdp.browser,
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
    });
    const session = await target.session();
    expect(session.storage['constructor']).toBe('v');
    expect(session.storage['token']).toBe('bearer-abc');
  });

  test('a snapshot the browser could not have sent is still refused — and is NOT retryable', async () => {
    // The other half, and it is the half that costs money: a parse that DOES fail must not be
    // re-labelled `X_SCRAPE_BROWSER_UNREACHABLE`, which `errors.ts` registers `retryable`.
    const cdp = answering({ querySelectorAll: JSON.stringify([{ tag: 42 }]) });
    const target = await cdpTarget({
      page: cdp.page,
      browser: cdp.browser,
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
    });
    let code: string | undefined;
    try {
      await target.query('.row');
    } catch (thrown) {
      code = (thrown as { code?: string }).code;
    }
    expect(code).toBe('X_VALIDATION_FAILED');
  });
});

/**
 * A launcher with no `setOfflineMode` is refused BY NAME, not silently accepted. `CdpPageLike`
 * declares it optional — this file is the shape of somebody else's object — and this is the half
 * that keeps optional from meaning unwired, exactly as `cookies()` is refused today.
 */
describe('unit · setOfflineMode on a launcher that does not have it', () => {
  test('X_NOT_IMPLEMENTED, with a fix naming the upgrade — and NOT re-labelled retryable', async () => {
    const rec = recorder('https://shop.test/o');
    const target = await cdpTarget({
      page: rec.page,
      browser: rec.browser,
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
    });
    let thrown: { code?: string; fix?: string } = {};
    try {
      await target.setOfflineMode(true);
    } catch (caught) {
      thrown = caught as { code?: string; fix?: string };
    }
    // `guard()` passes this through: `X_SCRAPE_BROWSER_UNREACHABLE` is registered retryable, and
    // the method is still missing on attempt five.
    expect(thrown.code).toBe('X_NOT_IMPLEMENTED');
    expect(thrown.fix).toContain('puppeteer-core');
  });

  test('a launcher that HAS it is handed the value, unchanged', async () => {
    const rec = recorder('https://shop.test/o');
    const seen: boolean[] = [];
    const target = await cdpTarget({
      page: {
        ...rec.page,
        setOfflineMode: (enabled: boolean) => {
          seen.push(enabled);
          return Promise.resolve();
        },
      },
      browser: rec.browser,
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
    });
    await target.setOfflineMode(true);
    await target.setOfflineMode(false);
    expect(seen).toEqual([true, false]);
  });
});
