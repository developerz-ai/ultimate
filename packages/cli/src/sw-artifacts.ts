// `sw.js` and its registration script, built from the route table and the island bundle — the one
// caller of `@ultimat3/pwa`'s `generateServiceWorker`, which had none outside its own package
// until #390. Beside `pwa-artifacts.ts` and not inside it: that file needs a root and a config
// file, this one needs a booted app and a finished build.

import type { PrecacheAsset, PrecacheManifest, PwaRoute } from '@ultimat3/pwa';
import { generateServiceWorker } from '@ultimat3/pwa';
import type { RouteDescriptor } from '@ultimat3/render';
import type { IslandBundle } from './island-bundle';
import { msg } from './messages';
import type { PwaArtifacts } from './pwa-artifacts';
import type { StyleBundle } from './style-bundle';

/** Root scope, so `/sw.js` and nothing under a directory — `assertScope` refuses the rest. */
export const SERVICE_WORKER_PATH = '/sw.js';
export const SW_SCOPE = '/';

/**
 * The registration is an EXTERNAL script, never inline, and that is a CSP fact rather than a
 * preference: `startWeb` computes a `script-src` sha256 for each inline script it serves, so an
 * unhashed one is blocked in the container while passing report-only under `x dev` — which is
 * exactly how the hydration runtime shipped broken once already.
 */
export const SW_REGISTER_PATH = '/x-sw-register.js';

export interface ServiceWorkerArtifacts {
  /** `sw.js`, deterministic for identical input. */
  readonly source: string;
  /** `x-sw-register.js`, the four lines that install it. */
  readonly register: string;
  /** The `<script src>` tag, appended to `PwaArtifacts.head` by every surface that serves it. */
  readonly head: string;
  readonly precache: PrecacheManifest;
  /** Precache budget findings — reported by `x build`, so the ceiling is not a designed thing. */
  readonly warnings: readonly string[];
}

export interface ServiceWorkerInput {
  /**
   * What `loadPwaArtifacts` read out of `app.config.ts`. The whole object rather than three loose
   * fields, because a second reader of that file is a second answer to what the app declared.
   */
  readonly pwa: PwaArtifacts;
  readonly buildId: string;
  readonly routes: readonly RouteDescriptor[];
  readonly islands: IslandBundle;
  /**
   * The surface stylesheets every document links. Precached beside the island chunks and for the
   * same reason: they are content-addressed and served `immutable`, and a document that reaches
   * the offline fallback with no CSS is a page the visitor cannot read.
   */
  readonly styles: StyleBundle;
  /**
   * What the build RENDERED, keyed by the route path it was rendered for. Optional because only a
   * static export has documents to hash: `x dev` and the container emit the worker at boot, where
   * no page has been built yet, and `buildPrecacheManifest` falls back to the build id for a route
   * this map does not name.
   */
  readonly documents?: ReadonlyMap<string, RenderedDocument>;
}

/**
 * One rendered document, as the precache manifest needs it.
 *
 * `revision` is `contentHash(html)` — `@ultimat3/render`'s own, the function that already stamps
 * an ETag — and never the build id. `precache.ts`' header states the rule and nothing kept it:
 * `pwaRoutes` projected four of `PwaRoute`'s eight fields, so every route entry read
 * `{"url":"/","revision":"build-aaa","bytes":0}` and two deploys of a byte-identical site
 * re-fetched every precached document. The zero was the second half — `DEFAULT_PRECACHE_WARN_BYTES`
 * is a 5 MB budget over a total that could not count one byte of HTML.
 */
export interface RenderedDocument {
  readonly revision: string;
  readonly bytes: number;
}

/**
 * The route table, as the service worker sees it. `api/` is dropped: an API response is a JSON
 * document whose freshness is the app's business, and precaching one serves a stale answer to a
 * client that had a network. Only the fields a browser can act on cross — a descriptor carries
 * budgets and policy flags it has no use for — plus, for a route this build rendered, the content
 * hash and the byte count of the document it produced.
 */
const pwaRoutes = (
  routes: readonly RouteDescriptor[],
  documents: ReadonlyMap<string, RenderedDocument>,
): readonly PwaRoute[] =>
  // `flatMap` rather than `filter().map()`: the filter's predicate does not narrow `surface` for
  // the map that follows it, and `PwaRoute` declares the two navigable surfaces only. A cast would
  // hide the day a fifth surface arrives.
  routes.flatMap((route): readonly PwaRoute[] => {
    // `shared/` is dropped with `api/`, and for a stronger reason: it is not a URL at all — the
    // surface exists so two routes can import one module, and a browser can never navigate to it.
    if (route.surface !== 'site' && route.surface !== 'app') return [];
    // A `Map`, so a route path that happens to spell a prototype member cannot answer with one.
    const document = documents.get(route.path);
    return [
      {
        path: route.path,
        surface: route.surface,
        mode: route.mode,
        offline: route.offline,
        dynamic: route.dynamic,
        // Absent rather than invented for a route no build rendered — an `ssr` page, or one this
        // pass could not produce. `buildPrecacheManifest` then falls back to the build id, which
        // is the honest answer when there are no bytes to hash.
        ...(document === undefined ? {} : { revision: document.revision, bytes: document.bytes }),
      },
    ];
  });

/**
 * Every island chunk and every surface stylesheet, precached. They are content-addressed and
 * served `immutable`, so the revision IS the URL's hash and a byte-identical asset across deploys
 * is never re-downloaded.
 *
 * Sorted by url, because `buildPrecacheManifest` sorts its own entries but the ASSET list is what
 * decides which of two equal urls wins, and `sw.js` must be byte-identical for identical input.
 */
const staticAssets = (islands: IslandBundle, styles: StyleBundle): readonly PrecacheAsset[] =>
  [...islands.chunks, ...styles.chunks]
    .map((chunk) => ({ url: chunk.url, revision: chunk.url, bytes: chunk.bytes }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

/**
 * Four lines, and every one of them earns it. `load` because registration competes with the page's
 * own first paint for the same network. `scope: '/'` stated rather than inferred, so a change to
 * where the file is served is a build-time refusal (`assertScope`) instead of a worker that
 * silently controls a subdirectory. The `catch` because a registration that throws in a browser
 * with service workers disabled — an incognito profile, an enterprise policy — must not take an
 * otherwise working page down with it.
 */
const registerSource = (): string =>
  `if ('serviceWorker' in navigator) {
  addEventListener('load', function () {
    navigator.serviceWorker
      .register(${JSON.stringify(SERVICE_WORKER_PATH)}, { scope: ${JSON.stringify(SW_SCOPE)} })
      .catch(function (error) { console.warn('service worker registration failed', error); });
  });
}
`;

/**
 * Build the worker, or answer `undefined` for an app that declared no PWA.
 *
 * A bad `sw.js` is sticky in a way a manifest is not: a manifest a browser dislikes is ignored, a
 * worker that installs and caches wrong keeps serving wrong bytes until the user clears site data.
 * That is why this landed only once a real browser could be driven —
 * `packages/cli/e2e/service-worker.e2e.test.ts` installs the emitted worker in Chrome, takes the
 * network away and asserts the fallback renders.
 *
 * `pwa.enabled` is the one switch, and it is already spent: `loadPwaArtifacts` answers `undefined`
 * for an app that declared no PWA, so a caller only reaches this with an installable one.
 * `defineConfig` refuses `enabled: true` without an absolute `offline.fallback`, and a
 * hand-written config that lacks one reads as `null` here — so `requireOfflineFallback` inside
 * `generateServiceWorker` can never be the thing that fails, and the app gets no worker rather
 * than a worker caching a path nobody declared.
 */
export function serviceWorkerArtifacts(
  input: ServiceWorkerInput,
): ServiceWorkerArtifacts | undefined {
  const pwa = input.pwa;
  const head = serviceWorkerHead(pwa);
  const fallback = pwa.offline.fallback;
  // One predicate DECIDES — `serviceWorkerHead`, so a document can never name a script this
  // function then declines to emit — and the `null` check is what NARROWS `fallback` below:
  // TypeScript cannot learn a `string` from the other's answer, and a cast would hide the day the
  // two stop agreeing.
  if (head === undefined || fallback === null) return undefined;
  const documents = input.documents ?? new Map<string, RenderedDocument>();
  // The offline document is the one entry `buildPrecacheManifest` adds ITSELF, as
  // `reason: 'fallback'`, ahead of every route — and `add()` keeps the first entry per url, so its
  // revision is the one that decides. Without this pair it was the build id whatever the build
  // knew, which re-downloaded the single page an offline navigation depends on on every deploy.
  // Absent when this pass did not render the fallback (no route serves it — `x doctor` reports
  // that as `X_PWA_NO_OFFLINE_FALLBACK`), and then `@ultimat3/pwa` falls back to the build id.
  const fallbackDocument = documents.get(fallback);
  const output = generateServiceWorker(
    pwaRoutes(input.routes, documents),
    {
      scope: SW_SCOPE,
      swPath: SERVICE_WORKER_PATH,
      ...(fallbackDocument === undefined
        ? {}
        : {
            offlineFallbackRevision: fallbackDocument.revision,
            offlineFallbackBytes: fallbackDocument.bytes,
          }),
      offline: {
        fallback,
        ...(pwa.offline.image === null ? {} : { image: pwa.offline.image }),
        ...(pwa.offline.font === null ? {} : { font: pwa.offline.font }),
        neverCache: pwa.offline.neverCache,
      },
      capabilities: { backgroundSync: pwa.backgroundSync, push: pwa.push },
      assets: staticAssets(input.islands, input.styles),
    },
    input.buildId,
  );
  return {
    source: output.source,
    register: registerSource(),
    head,
    precache: output.precache,
    // `output.warnings` IS `output.precache.warnings` — the generator returns the manifest's list
    // verbatim — so it is read once, not twice. The push line is this module's own, and it is the
    // one thing the generator cannot say: `generateServiceWorker` emits a push handler only when a
    // VAPID key comes with the capability, and drops it in SILENCE otherwise. `pwa.push: true` in
    // an `app.config.ts` therefore wires nothing and reports nothing, which is `jobs.driver`'s
    // shape one package over.
    warnings: [...output.warnings, ...pushWarning(pwa)],
  };
}

/**
 * The one `<script src>` a document needs, or `undefined` for an app that gets no worker.
 *
 * Separate from `serviceWorkerArtifacts` because the two are wanted at different moments: a static
 * export has to put this tag in every document it renders, and the WORKER cannot be emitted until
 * those documents exist — its precache manifest is built from their content hashes. One predicate
 * for both (`offline.fallback === null` is `generateServiceWorker`'s refusal, spent early), so a
 * document can never name a script the export does not carry.
 */
export const serviceWorkerHead = (pwa: PwaArtifacts): string | undefined =>
  pwa.offline.fallback === null ? undefined : `<script src="${SW_REGISTER_PATH}" defer></script>`;

/**
 * `pwa.push: true` with nothing to sign a subscription with. There is no `pwa.vapid` config key
 * yet, so today this fires for EVERY app that sets the flag — deliberately: a switch that silently
 * does nothing is the defect this framework keeps re-shipping, and a warning naming the missing
 * half is the smallest honest answer until the key exists.
 */
const pushWarning = (pwa: PwaArtifacts): readonly string[] =>
  pwa.push ? [msg('cli.build.pushUnwired')] : [];
