// The emitted `/x-client-errors.js` executed against a stub window, not read: each door posts once,
// the caps hold, a foreign script is dropped, and a failing `fetch` neither throws nor re-enters.

import { describe, expect, test } from 'bun:test';
import { CLIENT_BUILD_META } from '@ultimat3/core';
import { NAVIGATED_EVENT } from '@ultimat3/render';
import {
  CLIENT_ERRORS_MAX_REPORTS,
  CLIENT_ERRORS_PATH,
  clientErrorsScript,
} from './client-errors-script';

type Listener = (event: unknown) => void;

interface Posted {
  readonly url: string;
  readonly init: { readonly keepalive?: boolean; readonly credentials?: string; body: string };
}

interface StubElement {
  readonly attributes: Record<string, string>;
  getAttribute(name: string): string | null;
}

const element = (attributes: Record<string, string>): StubElement => ({
  attributes,
  getAttribute: (name) => attributes[name] ?? null,
});

const ORIGIN = 'https://app.test';

/** A thenable that records whether its rejection was handled, so "never re-enters" is checkable. */
interface Recorded {
  handled: boolean;
}

function harness(
  options: {
    readonly failed?: readonly StubElement[];
    readonly fetch?: (url: string, init: Posted['init']) => unknown;
  } = {},
) {
  const listeners = new Map<string, Listener[]>();
  const posted: Posted[] = [];
  const settled: Recorded[] = [];
  let observer: ((records: readonly { target: StubElement }[]) => void) | undefined;
  const window = {
    addEventListener(type: string, listener: Listener): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  // What the client router changes on a swap: the body's failed islands, the build meta, the path.
  let failed: readonly StubElement[] = options.failed ?? [];
  let buildMeta: StubElement | null = null;
  const documentListeners = new Map<string, Listener[]>();
  const document = {
    currentScript: element({ 'data-build': 'build-7' }),
    documentElement: {},
    querySelectorAll: (): readonly StubElement[] => failed,
    querySelector: (selector: string): StubElement | null =>
      selector === `meta[name="${CLIENT_BUILD_META}"]` ? buildMeta : null,
    addEventListener(type: string, listener: Listener): void {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
  };
  const location = { origin: ORIGIN, pathname: '/app/settings' };
  const fetch = (url: string, init: Posted['init']): unknown => {
    posted.push({ url, init });
    if (options.fetch !== undefined) return options.fetch(url, init);
    const record: Recorded = { handled: false };
    settled.push(record);
    return {
      // biome-ignore lint/suspicious/noThenProperty: the stub IS a thenable, by design.
      then(_ok: unknown, failed: unknown) {
        record.handled = typeof failed === 'function';
        return this;
      },
    };
  };
  class MutationObserver {
    constructor(callback: (records: readonly { target: StubElement }[]) => void) {
      observer = callback;
    }
    observe(): void {
      // The callback is driven by the test through `mutate`.
    }
  }
  const run = new Function(
    'window',
    'document',
    'location',
    'fetch',
    'MutationObserver',
    clientErrorsScript(),
  );
  run(window, document, location, fetch, MutationObserver);
  const fire = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    posted,
    settled,
    fire,
    bodies: () => posted.map((post) => JSON.parse(post.init.body) as Record<string, unknown>),
    mutate: (target: StubElement) => observer?.([{ target }]),
    /** The URL moved with no swap: `history.pushState` by the app itself. */
    moveTo: (path: string) => {
      location.pathname = path;
    },
    /** The router swapped in `path`: new body, maybe a new build meta, then `NAVIGATED_EVENT`. */
    swap: (path: string, next: { build?: string; failed?: readonly StubElement[] } = {}) => {
      location.pathname = path;
      failed = next.failed ?? [];
      if (next.build !== undefined) buildMeta = element({ content: next.build });
      for (const listener of documentListeners.get(NAVIGATED_EVENT) ?? []) listener({});
    },
  };
}

const errorEvent = (message: string, filename = `${ORIGIN}/islands/form.js`) => ({
  message,
  filename,
  error: { stack: `Error: ${message}\n    at mount (${filename}:1:2)` },
});

describe('the browser reporter, executed', () => {
  test('a window error posts once to the route, with its path, build and stack', () => {
    const page = harness();
    page.fire('error', errorEvent('boom'));
    expect(page.posted).toHaveLength(1);
    expect(page.posted[0]?.url).toBe(CLIENT_ERRORS_PATH);
    expect(page.posted[0]?.init.keepalive).toBe(true);
    expect(page.posted[0]?.init.credentials).toBe('same-origin');
    expect(page.bodies()[0]).toEqual({
      kind: 'error',
      message: 'boom',
      path: '/app/settings',
      build: 'build-7',
      stack: `Error: boom\n    at mount (${ORIGIN}/islands/form.js:1:2)`,
    });
  });

  test('an unhandled rejection posts once', () => {
    const page = harness();
    page.fire('unhandledrejection', {
      reason: { message: 'nope', stack: `at x (${ORIGIN}/a.js:1:1)` },
    });
    expect(page.bodies()).toEqual([
      expect.objectContaining({ kind: 'rejection', message: 'nope', path: '/app/settings' }),
    ]);
  });

  test('an island that failed — before the script ran, or after — posts once each, by id', () => {
    const early = element({ 'data-x-failed': 'mount threw', 'data-x-island': 'settings-form' });
    const page = harness({ failed: [early] });
    page.mutate(element({ 'data-x-failed': 'later', 'data-x-island': 'feed' }));
    // An attribute mutation that cleared the marker is not a failure.
    page.mutate(element({ 'data-x-island': 'like' }));
    expect(page.bodies()).toEqual([
      expect.objectContaining({ kind: 'island', message: 'mount threw', island: 'settings-form' }),
      expect.objectContaining({ kind: 'island', message: 'later', island: 'feed' }),
    ]);
  });

  test(`at most ${CLIENT_ERRORS_MAX_REPORTS} per document: a 6th distinct failure is dropped`, () => {
    const page = harness();
    for (let index = 1; index <= CLIENT_ERRORS_MAX_REPORTS + 1; index += 1) {
      page.fire('error', errorEvent(`failure ${index}`));
    }
    expect(page.posted).toHaveLength(CLIENT_ERRORS_MAX_REPORTS);
  });

  test('one per distinct message: a repeat is dropped', () => {
    const page = harness();
    page.fire('error', errorEvent('same'));
    page.fire('error', errorEvent('same'));
    expect(page.posted).toHaveLength(1);
  });

  test("a foreign script's error and an opaque 'Script error.' are dropped", () => {
    const page = harness();
    page.fire('error', errorEvent('extension', 'chrome-extension://abc/content.js'));
    page.fire('error', errorEvent('cdn', 'https://cdn.test/lib.js'));
    page.fire('error', { message: 'Script error.', filename: '', error: null });
    page.fire('error', { message: 'Script error.', filename: `${ORIGIN}/x.js`, error: null });
    page.fire('unhandledrejection', {
      reason: { message: 'x', stack: 'at y (https://cdn.test/a.js:1:1)' },
    });
    expect(page.posted).toHaveLength(0);
  });

  test('a fetch rejection is handled, so the reporter never reports its own failure', () => {
    const page = harness();
    page.fire('error', errorEvent('boom'));
    expect(page.settled).toEqual([{ handled: true }]);
  });

  test('a fetch that throws, or that fires an error while sending, neither throws nor re-enters', () => {
    let fire: ((type: string, event: unknown) => void) | undefined;
    const page = harness({
      fetch: () => {
        fire?.('error', errorEvent('inside fetch'));
        // A thrown non-Error: what a hostile or polyfilled `fetch` may throw, and the input here.
        throw { failure: 'fetch is broken' };
      },
    });
    fire = page.fire;
    expect(() => page.fire('error', errorEvent('outer'))).not.toThrow();
    expect(page.posted).toHaveLength(1);
  });

  test('a hostile reason whose toString throws does not escape the listener', () => {
    const page = harness();
    const reason = {
      toString(): string {
        throw { failure: 'hostile' };
      },
    };
    expect(() => page.fire('unhandledrejection', { reason })).not.toThrow();
  });

  // The client router runs this script ONCE per tab and swaps documents under it: every cap is per
  // document, or five reports on the first page silence the tab for the rest of its life.
  describe('across client-router swaps', () => {
    test('the cap resets per document: five on one page, five more on the next', () => {
      const page = harness();
      for (let index = 1; index <= CLIENT_ERRORS_MAX_REPORTS + 1; index += 1) {
        page.fire('error', errorEvent(`first ${index}`));
      }
      page.swap('/app/feed');
      for (let index = 1; index <= CLIENT_ERRORS_MAX_REPORTS + 1; index += 1) {
        page.fire('error', errorEvent(`second ${index}`));
      }
      expect(page.posted).toHaveLength(CLIENT_ERRORS_MAX_REPORTS * 2);
    });

    test('the same island failing on a second page is reported there too, by that path', () => {
      const failing = () => element({ 'data-x-failed': 'mount threw', 'data-x-island': 'like' });
      const page = harness();
      page.mutate(failing());
      page.swap('/app/posts/1', { failed: [failing()] });
      expect(page.bodies().map((body) => body['path'])).toEqual(['/app/settings', '/app/posts/1']);
    });

    test('the dedupe is per path even with no swap event (an app pushState of its own)', () => {
      const page = harness();
      page.fire('error', errorEvent('same'));
      page.moveTo('/app/feed');
      page.fire('error', errorEvent('same'));
      expect(page.bodies().map((body) => body['path'])).toEqual(['/app/settings', '/app/feed']);
    });

    test('an island the router carried across, already reported, is not reported again', () => {
      const kept = element({ 'data-x-failed': 'mount threw', 'data-x-island': 'like' });
      const page = harness({ failed: [kept] });
      page.swap('/app/feed', { failed: [kept] });
      expect(page.posted).toHaveLength(1);
    });

    test("the build is the swapped-in document's, read from its meta", () => {
      const page = harness();
      page.fire('error', errorEvent('before'));
      page.swap('/app/feed', { build: 'build-8' });
      page.fire('error', errorEvent('after'));
      expect(page.bodies().map((body) => body['build'])).toEqual(['build-7', 'build-8']);
    });
  });
});
