// The emitted `sw.js` executed, not read: the install block and the precache entries it writes,
// driven against a stub `caches`/`fetch` so an entry keyed where no strategy looks for it is a
// failing test rather than an offline page nobody sees until production. The generator's emitted
// TEXT — rules, markers, refusals — is `service-worker.test.ts`.

import { describe, expect, test } from 'bun:test';
import { OUTBOX_DRAIN_MESSAGE } from '@ultimat3/core';
import type { ServiceWorkerConfig } from './service-worker';
import { generateServiceWorker } from './service-worker';
import { config, swHarness } from './service-worker-harness-fixture';
import type { PwaRoute } from './strategies';
import { cacheNamespace } from './version-skew';

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

  // Online, the same miss cost a second download of every precached byte: the network is asked
  // ONCE per navigation — for the page — and never a second time for a mis-keyed copy.
  test('online, a precached page costs one network request, not two', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(precached, config, 'build-1').source);
    await sw.install();
    const afterInstall = sw.fetched.length;

    await sw.request('/pricing');
    expect(sw.fetched.slice(afterInstall)).toEqual(['https://app.test/pricing']);
  });

  /**
   * The Shift+F5 defect (22.3.1, measured on notificado.co): a `static` route with
   * `offline: 'precache'` was cache-first, so every online navigation was answered with the HTML
   * this worker precached — the previous deploy's, naming the previous deploy's hashed CSS and
   * islands. The precache is the OFFLINE copy; online, the network's document wins.
   */
  test('online, a precached page is the NEW deploy the server answers, never the precached copy', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(precached, config, 'build-1').source);
    await sw.install();
    sw.answerWith((request) =>
      new URL(request.url).pathname === '/pricing' ? new Response('the next deploy') : undefined,
    );

    expect(await (await sw.request('/pricing')).text()).toBe('the next deploy');
    // And the fresh copy is what offline answers from now on.
    sw.goOffline();
    expect(await (await sw.request('/pricing')).text()).toBe('the next deploy');
  });

  /**
   * A new worker used to WAIT until every tab of the origin closed: nothing posted `skip-waiting`,
   * so a returning visitor ran the old worker for days. The install block skips waiting itself —
   * which is also what moves a browser still on a 22.3.1 worker, whose register script never asks.
   */
  test('the install skips waiting, so the new worker takes over without a closed tab', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(precached, config, 'build-1').source);
    expect(sw.skippedWaiting()).toBe(0);
    await sw.install();
    expect(sw.skippedWaiting()).toBe(1);
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

// The deadlock this escapes was measured on a running app, not imagined: a dev server restarted
// onto a new build, the active worker went on stamping the old id, every navigation came back 409,
// and the replacement worker sat at `waiting: "installed"` because a waiting worker takes over only
// once every client is released — which the refusal page, not being the app, never arranges. The
// error's own advice was "reload the page"; reloading re-entered the same worker and earned the
// same 409. Only a hand-posted `skip-waiting` from devtools broke it.
describe('the emitted fetch block, against a server on a newer build', () => {
  const routes: readonly PwaRoute[] = [
    { path: '/', surface: 'app', mode: 'ssr', offline: 'runtime' },
  ];
  const skew = (request: Request): Response | undefined =>
    request.headers.get('x-ultimate-build') === 'build-1'
      ? new Response('{"code":"X_BUILD_SKEW"}', {
          status: 409,
          headers: { 'x-ultimate-build': 'build-2' },
        })
      : undefined;

  test('answers the request for real instead of handing the client the refusal', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    sw.answerWith(skew);

    const response = await sw.request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('bytes for /');
  });

  test('stops stamping the id that was refused, so the next request is not refused either', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    sw.answerWith(skew);

    await sw.request('/');
    await sw.request('/');
    // First stamped and refused; every request after it goes out bare.
    expect(sw.stamps[0]).toBe('build-1');
    expect(sw.stamps.slice(1)).toEqual(sw.stamps.slice(1).map(() => null));
  });

  test('tells every window which build is waiting, so the app can activate it', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    sw.answerWith(skew);

    await sw.request('/');
    expect(sw.messages).toEqual([{ type: 'AppUpdateAvailable', to: 'build-2' }]);
  });

  // A 409 is not automatically skew: a route may answer one of its own, and swallowing it would
  // turn a conflict the app must handle into a silent retry with the guard disabled.
  test('leaves a 409 that carries no other build id alone', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    sw.answerWith(() => new Response('nope', { status: 409 }));

    expect((await sw.request('/')).status).toBe(409);
    expect(sw.messages).toEqual([]);
    expect(sw.stamps[0]).toBe('build-1');
  });
});

/**
 * The Background Sync API is absent in Safari and in Firefox, so `registerOutboxSync` falls back
 * to an `online` listener that posts `{ type: 'flush-outbox' }` to the controller — and the
 * message handler answered only `skip-waiting` and `build-id`, so on exactly the browsers the
 * fallback exists for, an offline mutation queue was never drained. Silent: no rejection, no log,
 * no request. Executed rather than asserted on the text, because a handler that names the type and
 * calls nothing would satisfy a `toContain`.
 */
describe('the offline outbox drain, executed', () => {
  const syncConfig: ServiceWorkerConfig = {
    offline: { fallback: '/offline' },
    capabilities: { backgroundSync: true },
  };

  test('the no-Background-Sync fallback message tells the open tabs to drain', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker([], syncConfig, 'build-1').source);

    await sw.message({ type: 'flush-outbox' });

    expect(sw.messages).toEqual([{ type: OUTBOX_DRAIN_MESSAGE }]);
    expect(sw.fetched).toEqual([]);
  });

  test('and no other message type does, so a skip-waiting is not a flush', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker([], syncConfig, 'build-1').source);

    await sw.message({ type: 'skip-waiting' });
    await sw.message({ type: 'build-id' });

    expect(sw.messages).toEqual([]);
  });

  /**
   * `drainOutbox` is only emitted with the capability, so an unconditional handler would answer a
   * `flush-outbox` with a `ReferenceError` inside `waitUntil` — uncatchable by the page that sent
   * it — in every app that leaves `backgroundSync` off.
   */
  test('a worker without the capability ignores the message instead of throwing', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker([], config, 'build-1').source);

    await sw.message({ type: 'flush-outbox' });

    expect(sw.messages).toEqual([]);
  });
});
