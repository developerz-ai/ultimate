// The emitted `sw.js` executed, not read: the install block and the precache entries it writes,
// driven against a stub `caches`/`fetch` so an entry keyed where no strategy looks for it is a
// failing test rather than an offline page nobody sees until production. The generator's emitted
// TEXT — rules, markers, refusals — is `service-worker.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { ServiceWorkerConfig } from './service-worker';
import { generateServiceWorker } from './service-worker';
import type { PwaRoute } from './strategies';
import { cacheNamespace } from './version-skew';

const config: ServiceWorkerConfig = {
  offline: { fallback: '/offline' },
  capabilities: { push: false, backgroundSync: false, badging: false },
  vapid: { publicKey: 'BKxDemo', subject: 'mailto:ops@example.test' },
};

type SwListener = (event: SwEvent) => void;

interface SwEvent {
  readonly request?: Request;
  waitUntil(work: Promise<unknown>): void;
  respondWith(work: Promise<Response>): void;
}

const SW_ORIGIN = 'https://app.test';

/** A service worker resolves a relative URL against its scope; Bun's global `Request` cannot. */
class SwRequest extends Request {
  constructor(input: Request | string, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, SW_ORIGIN).href : input, init);
  }
}

/** Keyed by absolute URL, exactly as `Cache` is with `ignoreSearch` at its default `false`. */
class StubCache {
  readonly entries = new Map<string, Response>();
  #fetch: (request: Request) => Promise<Response>;

  constructor(fetcher: (request: Request) => Promise<Response>) {
    this.#fetch = fetcher;
  }

  #key(request: Request | string): string {
    return typeof request === 'string' ? new URL(request, SW_ORIGIN).href : request.url;
  }

  async match(request: Request | string): Promise<Response | undefined> {
    return this.entries.get(this.#key(request));
  }

  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(this.#key(request), response);
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

function swHarness() {
  const fetched: string[] = [];
  let offline = false;
  const fetcher = async (request: Request | string): Promise<Response> => {
    const url = typeof request === 'string' ? request : request.url;
    fetched.push(url);
    if (offline) throw new TypeError('network down');
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
    clients: { claim: async (): Promise<void> => undefined, matchAll: async () => [] },
    skipWaiting: (): void => undefined,
  };

  return {
    caches,
    fetched,
    goOffline: (): void => {
      offline = true;
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
    async request(path: string): Promise<Response> {
      let answer: Promise<Response> | undefined;
      listeners.get('fetch')?.({
        request: new SwRequest(path),
        waitUntil: () => undefined,
        respondWith: (p) => {
          answer = p;
        },
      });
      if (answer === undefined) expect.unreachable(`no handler answered ${path}`);
      return await answer;
    },
  };
}

describe('the emitted install block, executed', () => {
  const precached: readonly PwaRoute[] = [
    { path: '/', surface: 'site', mode: 'static', offline: 'precache', revision: 'aaaa1111' },
    {
      path: '/pricing',
      surface: 'site',
      mode: 'static',
      offline: 'precache',
      revision: 'bbbb2222',
    },
  ];

  test('keys every precached entry under the bare URL, which is where strategies look', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(precached, config, 'build-1').source);
    await sw.install();

    const cache = sw.caches.get(cacheNamespace('build-1', 'precache'));
    expect([...(cache?.entries.keys() ?? [])].sort()).toEqual([
      'https://app.test/',
      'https://app.test/offline',
      'https://app.test/pricing',
    ]);
  });

  test('fetches each entry revision-addressed, so a deploy re-downloads only what changed', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(precached, config, 'build-1').source);
    await sw.install();

    expect(sw.fetched).toContain('https://app.test/pricing?v=bbbb2222');
  });

  // The measured failure: offline, `cacheFirst` looked up `/pricing`, the entry was stored as
  // `/pricing?v=bbbb2222`, and the user got the offline document instead of the precached page.
  test('serves a precached page offline instead of the offline fallback', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(precached, config, 'build-1').source);
    await sw.install();
    sw.goOffline();

    expect(await (await sw.request('/pricing')).text()).toBe('bytes for /pricing');
  });

  // Online, the same miss cost a second download of every precached byte.
  test('answers online from the precache without a second network request', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(precached, config, 'build-1').source);
    await sw.install();
    const afterInstall = sw.fetched.length;

    await sw.request('/pricing');
    expect(sw.fetched).toHaveLength(afterInstall);
  });
});

/**
 * A precache URL that already carries a query. `PrecacheAsset.url` is public API and a bundler
 * emits `?v=<hash>` on its own, so `url+'?v='+revision` produced `...?locale=en?v=build-1`: a
 * second `?` inside the query string. Either the server answers non-200 — and `cache.addAll` is
 * all-or-nothing, so the whole `install` rejects and the worker never activates — or it answers
 * 200 for a URL that is not the asset. Both are invisible in the emitted text.
 */
describe('a precache URL that already has a query', () => {
  const queried: ServiceWorkerConfig = {
    ...config,
    assets: [
      { url: '/_x/data/pricing.json?locale=en', revision: 'aaaa1111', bytes: 2_048 },
      { url: '/assets/app.js?v=deadbeef', revision: 'bbbb2222', bytes: 64_512 },
    ],
  };

  test('the revision is appended with & so the asset’s own query survives', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker([], queried, 'build-1').source);
    await sw.install();

    expect(sw.fetched).toContain('https://app.test/_x/data/pricing.json?locale=en&v=aaaa1111');
    expect(sw.fetched).toContain('https://app.test/assets/app.js?v=deadbeef&v=bbbb2222');
    // The shape that shipped: a query string holding a second `?`.
    expect(sw.fetched.filter((url) => url.includes('?v=aaaa1111'))).toEqual([]);
  });

  test('the entry is still re-keyed under the URL the strategies look up', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker([], queried, 'build-1').source);
    await sw.install();

    const cache = sw.caches.get(cacheNamespace('build-1', 'precache'));
    expect([...(cache?.entries.keys() ?? [])]).toContain(
      'https://app.test/_x/data/pricing.json?locale=en',
    );
  });
});
