// `sw.js` and its registration script, built from the route table and the island bundle — the one
// caller of `@ultimat3/pwa`'s `generateServiceWorker`, which had none outside its own package
// until #390. Beside `pwa-artifacts.ts` and not inside it: that file needs a root and a config
// file, this one needs a booted app and a finished build.

import { localeConfig, routedLocales } from '@ultimat3/i18n';
import type { PrecacheManifest } from '@ultimat3/pwa';
import { generateServiceWorker } from '@ultimat3/pwa';
import type { RouteDescriptor } from '@ultimat3/render';
import type { IslandBundle } from './island-bundle';
import { ISLAND_BASE_PATH } from './island-bundle';
import { msg } from './messages';
import type { PwaArtifacts } from './pwa-artifacts';
import type { StyleBundle } from './style-bundle';
import type { RenderedDocument, RoutedLocales } from './sw-precache-plan';
import { localePrefixes, precacheAssets, pwaRoutes } from './sw-precache-plan';

export type { RenderedDocument, RoutedLocales } from './sw-precache-plan';

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

/** How long a returning tab waits between two `sw.js` update checks — five minutes. */
export const SW_UPDATE_INTERVAL_MS = 300_000;

export interface ServiceWorkerArtifacts {
  /** `sw.js`, deterministic for identical input. */
  readonly source: string;
  /** `x-sw-register.js`, the lines that install it and look for its successor. */
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
  /**
   * The page's framework scripts — realtime's page boot and sync worker (`pageSync(…).scripts`).
   * Precached beside the island chunks for their reason: source-addressed and `immutable`, and an
   * offline reload that cannot load the boot restores no record and shows the old count.
   */
  readonly scripts?: readonly { readonly url: string; readonly bytes: number }[];
  /**
   * The routed locales, default first. Absent, `@ultimat3/i18n`'s own — the answer the server routes
   * with, set once the app's catalogs are loaded, which every caller has done by now.
   */
  readonly locales?: RoutedLocales;
}

/**
 * The registration, and every line of it earns its bytes. `load` because registration competes with
 * the page's own first paint for the same network. `scope: '/'` stated rather than inferred, so a
 * change to where the file is served is a build-time refusal (`assertScope`) instead of a worker
 * that silently controls a subdirectory. The `catch` because a registration that throws in a
 * browser with service workers disabled — an incognito profile, an enterprise policy — must not
 * take an otherwise working page down with it.
 *
 * `registration.update()` when a hidden tab comes back, at most once per `SW_UPDATE_INTERVAL_MS`
 * (22.3.2). A browser checks for a new `sw.js` on a NAVIGATION; a tab left open for days makes
 * none, so the new worker was found only on the click that was already answered by the old one. The
 * throttle keeps an alt-tabbing reader from re-downloading the worker on every focus, and the
 * swallowed rejection is the offline case. It never posts `skip-waiting` and never reloads: the
 * worker skips waiting itself (`@ultimat3/pwa`'s install block), and a reload under a reader who is
 * typing is the one thing an update must not do — the next navigation gets the new HTML.
 *
 * EXPORTED because a static export has to put these bytes on disk BEFORE it renders, not after.
 * The file is named by every document and weighed by `measureDocumentJs`, and it used to be
 * written last, beside `sw.js` — so the measurement read a file that did not exist yet on a clean
 * output directory, and the PREVIOUS build's copy on a reused one. `sw.js` still comes last, for
 * the reason its own comment gives (its precache manifest is built from the rendered documents'
 * content hashes); this half depends on nothing but constants, so it can and must come first.
 */
export const serviceWorkerRegistration = (): string =>
  `if ('serviceWorker' in navigator) {
  addEventListener('load', function () {
    navigator.serviceWorker
      .register(${JSON.stringify(SERVICE_WORKER_PATH)}, { scope: ${JSON.stringify(SW_SCOPE)} })
      .then(function (registration) {
        var checked = Date.now();
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState !== 'visible') return;
          if (Date.now() - checked < ${SW_UPDATE_INTERVAL_MS}) return;
          checked = Date.now();
          registration.update().catch(function () {});
        });
      })
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
  const locales = input.locales ?? { routed: routedLocales(), fallback: localeConfig().fallback };
  const output = generateServiceWorker(
    pwaRoutes(input.routes, documents, locales),
    {
      scope: SW_SCOPE,
      runtimeAssets: [`${ISLAND_BASE_PATH}/`],
      localePrefixes: localePrefixes(locales),
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
        personalPages: pwa.offline.personalPages,
      },
      capabilities: { backgroundSync: pwa.backgroundSync, push: pwa.push },
      assets: precacheAssets({
        routes: input.routes,
        documents,
        locales,
        islands: input.islands,
        styles: input.styles,
        scripts: input.scripts ?? [],
        fallback,
      }),
    },
    input.buildId,
  );
  return {
    source: output.source,
    register: serviceWorkerRegistration(),
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
