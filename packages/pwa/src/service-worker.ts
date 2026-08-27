/**
 * `sw.js` is emitted from the route table. You never open it — that is this package's
 * whole thesis. Hand-written service workers rot because they encode routing decisions a
 * second time, and the second copy is the one nobody updates.
 *
 * Output is deterministic for identical input: no timestamps, no randomness, sorted
 * everything, so two builds of the same commit produce byte-identical bytes and the SW
 * update check does not fire on a no-op deploy.
 */

import type { BackgroundSyncOptions } from './background-sync';
import { backgroundSyncSource } from './background-sync';
import type { CapabilityFlags, ResolvedCapabilities } from './capabilities';
import { isEnabled, resolveCapabilities } from './capabilities';
import { SwScopeInvalidError } from './errors';
import type { OfflineConfig } from './offline-fallback';
import { offlineFallbackSource, requireOfflineFallback } from './offline-fallback';
import type { PrecacheAsset, PrecacheManifest } from './precache';
import { buildPrecacheManifest, serializePrecacheManifest } from './precache';
import type { VapidConfig } from './push';
import { pushSource } from './push';
import type { PwaRoute, StrategyName } from './strategies';
import { STRATEGY_FN_NAMES, STRATEGY_SOURCE, strategyFor } from './strategies';
import {
  APP_UPDATE_AVAILABLE,
  assertBuildId,
  BUILD_ID_HEADER,
  cacheNamespace,
} from './version-skew';

export interface ServiceWorkerConfig {
  readonly scope?: string;
  /** Where `sw.js` is served from. Must be at or above `scope`. */
  readonly swPath?: string;
  readonly offline: Partial<OfflineConfig>;
  readonly capabilities?: CapabilityFlags;
  readonly assets?: readonly PrecacheAsset[];
  readonly shellUrl?: string;
  readonly shellRevision?: string;
  readonly shellBytes?: number;
  readonly vapid?: VapidConfig;
  readonly backgroundSync?: BackgroundSyncOptions;
  /** Build ids whose caches must survive this activation (see `retentionPlan`). */
  readonly retainBuildIds?: readonly string[];
  readonly precacheWarnBytes?: number;
}

export interface RouteRule {
  readonly pattern: string;
  readonly strategy: StrategyName;
  readonly cache: 'precache' | 'runtime' | 'pages';
}

export interface ServiceWorkerOutput {
  readonly source: string;
  readonly precache: PrecacheManifest;
  readonly rules: readonly RouteRule[];
  readonly capabilities: ResolvedCapabilities;
  readonly warnings: readonly string[];
}

/**
 * A SW served from `/js/sw.js` can only control `/js/`. This is the single most common
 * "why is my PWA not working" and it is checkable at build time.
 */
export function assertScope(swPath: string, scope: string): void {
  // A relative path has no directory to compare, and `''` is a prefix of every scope — so the
  // check passed for exactly the config most likely to be wrong. Refused, not normalised: where
  // the browser would resolve `sw.js` from is the registration call, which this cannot see.
  if (!swPath.startsWith('/')) {
    throw new SwScopeInvalidError(
      `sw.js is served from ${swPath}, which is relative, so the directory it can control is ` +
        `unknown at build time; the configured scope is ${scope}`,
      `set pwa.swPath to an absolute path — '${scope}sw.js' serves scope ${scope}`,
    );
  }
  const directory = swPath.slice(0, swPath.lastIndexOf('/') + 1);
  if (!scope.startsWith(directory)) {
    throw new SwScopeInvalidError(
      `sw.js is served from ${swPath}, which can only control ${directory}, but the ` +
        `configured scope is ${scope}`,
      `serve the service worker from ${scope}sw.js, or set pwa.scope to '${directory}'`,
    );
  }
}

const segmentsOf = (path: string): readonly string[] =>
  path.split('/').filter((segment) => segment.length > 0);

/**
 * How specifically a path claims a URL: a literal segment beats a `:param`, which beats a `*`.
 * The weights are `@ultimat3/render`'s `compilePattern`, verbatim (100 / 10 / 1), so the service
 * worker and the server rank the same pathname the same way.
 *
 * DUPLICATED, not imported: `render` and `pwa` are both tier 4 and a sideways import is a build
 * error. The shared home is `@ultimat3/core`'s `route-vocabulary.ts` — tier 0, already the owner of
 * `RENDER_MODES` / `OFFLINE_STRATEGIES` / `HYDRATE_STRATEGIES` for exactly this reason — and moving
 * it there is the follow-up this comment exists to name.
 */
function specificityOf(path: string): number {
  return segmentsOf(path).reduce((total, segment) => {
    if (segment.startsWith('*')) return total + 1;
    if (segment.startsWith(':')) return total + 10;
    return total + 100;
  }, 0);
}

/**
 * A catch-all is a FALLBACK, and it sorts behind every rule that is not one — a second key, because
 * a sum over segments cannot say it. `/` has no segments and so scores 0, while `/*rest` scores 1:
 * on specificity alone a single root catch-all outranks the home page, and with it every precached
 * entry in the table. The rule this expresses is the one a reader already assumes — a pattern that
 * matches everything answers only what nothing else claimed.
 */
const hasWildcard = (path: string): boolean =>
  segmentsOf(path).some((segment) => segment.startsWith('*'));

/**
 * Ordered MOST SPECIFIC FIRST, because the emitted `ruleFor` returns the first pattern that
 * matches and has no notion of specificity of its own. Sorted alphabetically it did not: `:` (0x3A)
 * and `*` (0x2A) both sort before every letter, so `/posts/:id` shadowed `/posts/new` and a single
 * `/*` catch-all shadowed the entire table — every entry in `PRECACHE_MANIFEST` downloaded at
 * install and then never looked up, and a route the app declared cacheable served `network-only`,
 * which offline is the `/offline` document.
 *
 * The path stays as the tie-break, so the emitted file is still byte-identical for identical input
 * — compared by CODE UNIT, never `localeCompare`, which answers from the runtime's ICU default and
 * collation version: `/Posts` sorted before `/posts` on one machine and after it on the next, for
 * the same route table. The rule `@ultimat3/jobs`' `job.ts` states for `x.manifest.json`, applied
 * to the artifact this file emits.
 */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function routeRules(routes: readonly PwaRoute[]): readonly RouteRule[] {
  return [...routes]
    .filter((route) => route.surface !== 'api')
    .sort(
      (a, b) =>
        Number(hasWildcard(a.path)) - Number(hasWildcard(b.path)) ||
        specificityOf(b.path) - specificityOf(a.path) ||
        byCodeUnit(a.path, b.path),
    )
    .map((route) => {
      const strategy = strategyFor(route);
      return {
        pattern: toPattern(route.path),
        strategy,
        cache: cacheFor(route, strategy),
      };
    });
}

function cacheFor(route: PwaRoute, strategy: StrategyName): 'precache' | 'runtime' | 'pages' {
  if (strategy === 'network-only') return 'runtime';
  if (route.offline === 'precache' && route.dynamic !== true) return 'precache';
  return 'pages';
}

function toPattern(path: string): string {
  if (path === '/') return '^/$';
  const body = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '[^/]+';
      if (segment.startsWith('*')) return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return `^${body}/?$`;
}

/** Emit `sw.js`. `routes` are `@ultimat3/render` descriptors, passed as data. */
export function generateServiceWorker(
  routes: readonly PwaRoute[],
  config: ServiceWorkerConfig,
  buildId: string,
): ServiceWorkerOutput {
  assertBuildId(buildId);
  const scope = config.scope ?? '/';
  assertScope(config.swPath ?? `${scope}sw.js`, scope);

  const fallback = requireOfflineFallback(config.offline);
  const capabilities = resolveCapabilities(config.capabilities);
  const rules = routeRules(routes);

  const precache = buildPrecacheManifest({
    buildId,
    routes,
    offlineFallbackUrl: fallback.document,
    ...(config.assets === undefined ? {} : { assets: config.assets }),
    ...(config.shellUrl === undefined ? {} : { shellUrl: config.shellUrl }),
    ...(config.shellRevision === undefined ? {} : { shellRevision: config.shellRevision }),
    ...(config.shellBytes === undefined ? {} : { shellBytes: config.shellBytes }),
    ...(config.precacheWarnBytes === undefined ? {} : { warnBytes: config.precacheWarnBytes }),
  });

  const usedStrategies = [...new Set(rules.map((rule) => rule.strategy))].sort();
  const retained = [...new Set([buildId, ...(config.retainBuildIds ?? [])])].sort();

  const blocks: string[] = [
    header(buildId),
    constants(buildId, scope, retained, fallback.neverCache),
    `const PRECACHE_MANIFEST=${serializePrecacheManifest(precache)};`,
    `const ROUTE_RULES=${serializeRules(rules)};`,
    usedStrategies.map((strategy) => STRATEGY_SOURCE[strategy]).join('\n'),
    offlineFallbackSource(fallback),
    INSTALL_BLOCK,
    activateBlock(),
    fetchBlock(),
    messageBlock(),
  ];

  if (isEnabled(capabilities, 'push') && config.vapid !== undefined) {
    blocks.push(pushSource({ badging: isEnabled(capabilities, 'badging') }));
  }
  if (isEnabled(capabilities, 'backgroundSync')) {
    blocks.push(backgroundSyncSource(config.backgroundSync ?? {}));
  }

  return {
    source: `${blocks.join('\n\n')}\n`,
    precache,
    rules,
    capabilities,
    warnings: precache.warnings,
  };
}

function header(buildId: string): string {
  // `x build`, `As of 2026-08-27`, and it took until then to become true. This said
  // `generateServiceWorker(routes, config, buildId) from @ultimat3/pwa` — the CALL rather than a
  // command — because nothing in the tree called it: `x build` emitted no service worker, so the
  // line would have sent whoever found this file in a diff to a command that left it exactly as
  // they found it. `packages/cli/src/sw-artifacts.ts` is the caller now (#390), and `x build`
  // regenerates this file the way the comment always meant to say.
  return `// GENERATED by @ultimat3/pwa from the route table — do not edit.
// build: ${buildId}
// regenerate: x build`;
}

function constants(
  buildId: string,
  scope: string,
  retained: readonly string[],
  neverCache: readonly string[],
): string {
  return `
const BUILD_ID=${JSON.stringify(buildId)};
const SCOPE=${JSON.stringify(scope)};
const PRECACHE=${JSON.stringify(cacheNamespace(buildId, 'precache'))};
const RUNTIME=${JSON.stringify(cacheNamespace(buildId, 'runtime'))};
const PAGES=${JSON.stringify(cacheNamespace(buildId, 'pages'))};
const RETAINED=${JSON.stringify(retainedCaches(retained))};
const NEVER_CACHE=${JSON.stringify(neverCache)};
const BUILD_HEADER=${JSON.stringify(BUILD_ID_HEADER)};`.trim();
}

function retainedCaches(buildIds: readonly string[]): readonly string[] {
  return buildIds.flatMap((id) => [
    cacheNamespace(id, 'precache'),
    cacheNamespace(id, 'runtime'),
    cacheNamespace(id, 'pages'),
  ]);
}

function serializeRules(rules: readonly RouteRule[]): string {
  const rows = rules.map(
    (rule) =>
      `{"p":${JSON.stringify(rule.pattern)},"s":${JSON.stringify(STRATEGY_FN_NAMES[rule.strategy])},` +
      `"c":${JSON.stringify(rule.cache)}}`,
  );
  return `[${rows.join(',')}]`;
}

/**
 * The revision addresses the **fetch**, never the **key**. Every strategy looks an entry up with
 * `caches.match(req)` on the bare URL — `ignoreSearch` defaults to `false` — so an entry left
 * keyed under `?v=<revision>` is a permanent miss: offline serves the fallback document instead
 * of the page that was precached, and online every precached byte is downloaded a second time.
 * `addAll` still does the fetching, because its all-or-nothing failure is what stops a
 * half-populated precache from activating; the second pass only re-keys what it stored.
 *
 * The separator in front of `v=` is chosen per entry, because `PrecacheAsset.url` is public API
 * and a bundler emits a query of its own: a fixed `?` built `...?locale=en?v=<rev>`, and a single
 * non-200 for it rejects `addAll`, which rejects the install — no precache, no offline document,
 * no version-skew header, and a worker that never activates at all.
 */
const INSTALL_BLOCK = `
self.addEventListener('install',(event)=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(PRECACHE);
    // Revision is a content hash: unchanged assets are not re-downloaded across deploys.
    // The separator is picked per entry: a precache URL may already carry a query.
    const fetched=PRECACHE_MANIFEST.map((e)=>new Request(e.url+(e.url.indexOf('?')<0?'?':'&')+'v='+e.revision,{cache:'reload'}));
    await cache.addAll(fetched);
    for(let i=0;i<PRECACHE_MANIFEST.length;i++){
      const stored=await cache.match(fetched[i]);
      if(stored)await cache.put(new Request(PRECACHE_MANIFEST[i].url),stored);
      await cache.delete(fetched[i]);
    }
  })());
});`.trim();

function activateBlock(): string {
  return `
self.addEventListener('activate',(event)=>{
  event.waitUntil((async()=>{
    // Retain the last N deploys so a tab open across a release still resolves its chunks.
    const names=await caches.keys();
    await Promise.all(names.filter((n)=>n.startsWith('x-')&&RETAINED.indexOf(n)===-1)
      .map((n)=>caches.delete(n)));
    await self.clients.claim();
    const cs=await self.clients.matchAll({type:'window'});
    for(const c of cs)c.postMessage({type:${JSON.stringify(APP_UPDATE_AVAILABLE)},to:BUILD_ID});
  })());
});`.trim();
}

function fetchBlock(): string {
  return `
function ruleFor(url){
  for(const r of ROUTE_RULES){if(new RegExp(r.p).test(url.pathname))return r}
  return null
}
function cacheName(kind){return kind==='precache'?PRECACHE:kind==='pages'?PAGES:RUNTIME}
const STRATEGIES={cacheFirst:typeof cacheFirst==='function'?cacheFirst:null,
  networkFirst:typeof networkFirst==='function'?networkFirst:null,
  staleWhileRevalidate:typeof staleWhileRevalidate==='function'?staleWhileRevalidate:null,
  networkOnly:typeof networkOnly==='function'?networkOnly:null};
self.addEventListener('fetch',(event)=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(NEVER_CACHE.some((p)=>url.pathname.startsWith(p)))return;
  const rule=ruleFor(url);
  if(!rule)return;
  const fn=STRATEGIES[rule.s];
  if(!fn)return;
  // Every proxied request carries the client's build id so the server can detect skew.
  const tagged=new Request(req,{headers:withBuild(req.headers)});
  event.respondWith(fn(tagged,cacheName(rule.c),()=>offlineFallback(req)));
});
function withBuild(headers){
  const h=new Headers(headers);h.set(BUILD_HEADER,BUILD_ID);return h
}`.trim();
}

function messageBlock(): string {
  return `
self.addEventListener('message',(event)=>{
  const d=event.data||{};
  if(d.type==='skip-waiting')self.skipWaiting();
  if(d.type==='build-id')event.source&&event.source.postMessage({type:'build-id',buildId:BUILD_ID});
});`.trim();
}
