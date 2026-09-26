/**
 * The stand-in worker realm every `service-worker-*` suite runs the emitted `sw.js` in: stub
 * `caches` (whose `put` reads the whole body, as the real one does), a scriptable `fetch`, window
 * clients, and the install / activate / fetch / message events. Test-only — excluded from the
 * tarball by the `-fixture.ts` negation in `package.json`'s `files`.
 */

import { expect } from 'bun:test';
import type { ServiceWorkerConfig } from './service-worker';

export const config: ServiceWorkerConfig = {
  offline: { fallback: '/offline' },
  capabilities: { push: false, backgroundSync: false, badging: false },
  vapid: { publicKey: 'BKxDemo', subject: 'mailto:ops@example.test' },
};

export type SwListener = (event: SwEvent) => void;

export interface SwEvent {
  readonly request?: Request;
  /** What a `postMessage` from a window delivers — the payload, not a wrapper. */
  readonly data?: unknown;
  waitUntil(work: Promise<unknown>): void;
  respondWith(work: Promise<Response>): void;
}

export const SW_ORIGIN = 'https://app.test';

/** A service worker resolves a relative URL against its scope; Bun's global `Request` cannot. */
export class SwRequest extends Request {
  constructor(input: Request | string, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, SW_ORIGIN).href : input, init);
  }
}

/** Keyed by absolute URL, exactly as `Cache` is with `ignoreSearch` at its default `false`. */
export class StubCache {
  readonly entries = new Map<string, Response>();
  #fetch: (request: Request) => Promise<Response>;

  constructor(fetcher: (request: Request) => Promise<Response>) {
    this.#fetch = fetcher;
  }

  #key(request: Request | string): string {
    return typeof request === 'string' ? new URL(request, SW_ORIGIN).href : request.url;
  }

  async match(request: Request | string): Promise<Response | undefined> {
    // A clone, as the real `Cache` hands out: one stored entry answers many requests.
    return this.entries.get(this.#key(request))?.clone();
  }

  /** Reads the WHOLE body before it resolves, as the real `Cache.put` does. */
  async put(request: Request | string, response: Response): Promise<void> {
    const bytes = await response.arrayBuffer();
    this.entries.set(
      this.#key(request),
      new Response(bytes, { status: response.status, headers: response.headers }),
    );
  }

  async delete(request: Request | string): Promise<boolean> {
    return this.entries.delete(this.#key(request));
  }

  /** All-or-nothing, like the real one: a non-ok response rejects the whole install. */
  async addAll(requests: readonly Request[]): Promise<void> {
    const responses = await Promise.all(requests.map((request) => this.#fetch(request)));
    responses.forEach((response, i) => {
      if (!response.ok) throw new TypeError('addAll: request failed');
      const request = requests[i];
      if (request !== undefined) this.entries.set(request.url, response);
    });
  }
}

export function swHarness() {
  const fetched: string[] = [];
  /** The `x-ultimate-build` each proxied request carried, in order. `null` means unstamped. */
  const stamps: (string | null)[] = [];
  const messages: unknown[] = [];
  const windows: string[] = [];
  const extended: Promise<unknown>[] = [];
  /**
   * `waitUntil` calls a real browser REFUSES: after the fetch event's `respondWith` settled with no
   * extension still pending, `waitUntil` throws `InvalidStateError` and the worker may be killed
   * with the work unfinished. This harness used to accept it, so a strategy extending its event too
   * late passed every test. Recorded here AND thrown, as the browser throws.
   */
  const lateWaitUntil: string[] = [];
  /** How many times the worker called `self.skipWaiting()` — the install block must, once. */
  let skippedWaiting = 0;
  let offline = false;
  let respond: ((request: Request) => Response | undefined) | undefined;
  const fetcher = async (request: Request | string): Promise<Response> => {
    // A worker resolves a bare string against its own scope, so the stub must too — otherwise an
    // emitted call passing a path rather than a `Request` would fail here on `new URL`, which reads
    // as a broken worker rather than a broken harness.
    const url = typeof request === 'string' ? new URL(request, SW_ORIGIN).href : request.url;
    fetched.push(url);
    stamps.push(typeof request === 'string' ? null : request.headers.get('x-ultimate-build'));
    if (offline) throw new TypeError('network down');
    if (respond !== undefined && typeof request !== 'string') {
      const scripted = respond(request);
      if (scripted !== undefined) return scripted;
    }
    return new Response(`bytes for ${new URL(url).pathname}`, { status: 200 });
  };

  const caches = new Map<string, StubCache>();
  const cacheStorage = {
    async open(name: string): Promise<StubCache> {
      const existing = caches.get(name);
      if (existing !== undefined) return existing;
      const created = new StubCache(fetcher);
      caches.set(name, created);
      return created;
    },
    async keys(): Promise<string[]> {
      return [...caches.keys()];
    },
    async delete(name: string): Promise<boolean> {
      return caches.delete(name);
    },
  };

  const listeners = new Map<string, SwListener>();
  const self = {
    location: { origin: SW_ORIGIN },
    addEventListener(type: string, listener: SwListener): void {
      listeners.set(type, listener);
    },
    clients: {
      claim: async (): Promise<void> => undefined,
      // One window by default, with no URL; `openWindows` names the pages the worker controls.
      matchAll: async () =>
        (windows.length === 0 ? [undefined] : windows).map((url) => ({
          url,
          postMessage: (data: unknown): void => void messages.push(data),
        })),
    },
    skipWaiting: async (): Promise<void> => {
      skippedWaiting += 1;
    },
  };

  return {
    caches,
    fetched,
    stamps,
    messages,
    goOffline: (): void => {
      offline = true;
    },
    answerWith: (fn: (request: Request) => Response | undefined): void => {
      respond = fn;
    },
    load(source: string): void {
      const factory = new Function('self', 'caches', 'fetch', 'Request', source) as (
        scope: typeof self,
        storage: typeof cacheStorage,
        fetcher: (request: Request | string) => Promise<Response>,
        request: typeof SwRequest,
      ) => void;
      factory(self, cacheStorage, fetcher, SwRequest);
    },
    openWindows(...urls: string[]): void {
      windows.push(...urls);
    },
    async activate(): Promise<void> {
      let work: Promise<unknown> = Promise.resolve();
      listeners.get('activate')?.({
        waitUntil: (p) => {
          work = p;
        },
        respondWith: () => undefined,
      });
      await work;
    },
    async install(): Promise<void> {
      let work: Promise<unknown> = Promise.resolve();
      listeners.get('install')?.({
        waitUntil: (p) => {
          work = p;
        },
        respondWith: () => undefined,
      });
      await work;
    },
    lateWaitUntil,
    skippedWaiting: (): number => skippedWaiting,
    /** The response, as the page receives it — the cache copy is NOT awaited, see `settled`. */
    async respond(path: string): Promise<Response> {
      let answer: Promise<Response> | undefined;
      let finished = false;
      let pending = 0;
      const done = (): void => {
        pending -= 1;
      };
      listeners.get('fetch')?.({
        request: new SwRequest(path),
        waitUntil: (p) => {
          if (finished && pending === 0) {
            lateWaitUntil.push(path);
            throw new DOMException('the event handler is already finished', 'InvalidStateError');
          }
          pending += 1;
          p.then(done, done);
          extended.push(p);
        },
        respondWith: (p) => {
          answer = p;
        },
      });
      if (answer === undefined) expect.unreachable(`no handler answered ${path}`);
      const response = await answer;
      finished = true;
      return response;
    },
    /** Every `waitUntil` the worker has extended its events with, settled — the cache writes. */
    async settled(): Promise<void> {
      await Promise.allSettled(extended.splice(0));
    },
    /** A request whose cache writes have landed before it returns — what most tests assert on. */
    async request(path: string): Promise<Response> {
      const answer = await this.respond(path);
      await this.settled();
      return answer;
    },
    /** A `postMessage` from a window, awaited through the handler's own `waitUntil`. */
    async message(data: unknown): Promise<void> {
      let work: Promise<unknown> = Promise.resolve();
      listeners.get('message')?.({
        data,
        waitUntil: (p) => {
          work = p;
        },
        respondWith: () => undefined,
      });
      await work;
    },
  };
}
