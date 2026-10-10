/**
 * `isr` — static output plus background regeneration. Three things make it safe:
 * stale-while-revalidate (a stale page is served instantly, never a spinner),
 * single-flight regeneration (a traffic burst on a stale page renders once, not N times),
 * and tag-driven staleness (an action's `invalidates` marks exactly the dependent routes).
 */

import type { CacheTag, Revalidator, TagRevalidator } from '@ultimat3/cache';
import {
  dependentsOfKind,
  invalidateTags,
  markInvalidated,
  registerDependent,
  registerRevalidator,
  sampleFence,
  tagsIntersect,
  unregisterDependent,
} from '@ultimat3/cache';
import type { Scheduler } from '@ultimat3/core';
import { finiteCount, logger, renderThrowable, singleFlight } from '@ultimat3/core';
import { finiteStatus } from './finite-status';
import type { RouteDescriptor } from './registry';
import { describePages } from './registry';
import { entryTtlMs, isrResult } from './render-isr-result';
import type { IsrPolicy } from './render-isr-routes';
import { isrPolicyOf, isrRouteFor, parseWireTag } from './render-isr-routes';
import type { IsrEntry, IsrState, IsrStore } from './render-isr-store';
import { memoryIsrStore } from './render-isr-store';
import { contentHash } from './render-static';
import type { RenderResult } from './route';

/**
 * A render that also answers a status — what a loader's `withStatus(404, …)` becomes once the
 * document is built. A bare string is the 200 every render before this one was: the union is
 * additive, and a render function that never learned the object shape keeps compiling.
 */
export interface IsrRendered {
  readonly html: string;
  readonly status: number;
  /**
   * The render's own "do not keep this answer" — what a loader's `noStore(data)` becomes. Served to
   * the request that asked, `private, no-store`, and never written to the store. A 5xx needs no
   * flag: it is never stored whatever this says.
   */
  readonly noStore?: boolean;
}

/** A 5xx is the app's "the read failed, ask again" — an answer about a moment, never a document. */
const isServerError = (status: number): boolean => status >= 500;

/** One regeneration's outcome: the entry it rendered, and whether that entry may be kept. */
interface Generation {
  readonly entry: IsrEntry;
  readonly cacheable: boolean;
}

export type IsrRenderFn = (path: string) => string | IsrRendered | Promise<string | IsrRendered>;

/** One shape for the generator, so nothing below branches on what the render handed back. */
function renderedOf(rendered: string | IsrRendered): IsrRendered {
  return typeof rendered === 'string' ? { html: rendered, status: 200 } : rendered;
}

export interface IsrServeResult {
  readonly state: IsrState;
  readonly entry: IsrEntry;
  readonly result: RenderResult;
  /** True when this request started a background regeneration. */
  readonly regenerating: boolean;
}

export interface IsrControllerOptions {
  readonly store?: IsrStore;
  readonly buildId?: string;
  readonly now?: () => number;
  /** Route table provider — defaults to the real registry. */
  readonly routes?: () => readonly RouteDescriptor[];
  /** ISR-route dependents for a tag set; defaults to `@ultimat3/cache`'s graph. */
  readonly isrDependents?: (tags: readonly CacheTag[]) => readonly string[];
  /**
   * How long one regeneration may hold its path, in whole ms (≥ 1). Defaults to
   * `DEFAULT_ISR_REGENERATE_DEADLINE_MS`. There is no "forever": that is the bug it bounds.
   */
  readonly regenerateDeadlineMs?: number | undefined;
  /** Injected so the deadline is provable without waiting one out. */
  readonly schedule?: Scheduler | undefined;
}

/**
 * The ceiling on one regeneration's hold on its path — `@ultimat3/http`'s default
 * `requestTimeoutMs`, so the request that started a render has been cut off by then. Without it,
 * one `render()` that never settled pinned its path for the life of the process: a missed page
 * hung every later request, a stale one was served stale forever, and only a restart cleared it.
 * Eviction frees the PATH; the hung render is not cancellable from here, and its late result is
 * dropped if a newer regeneration has started since (`latest`).
 */
export const DEFAULT_ISR_REGENERATE_DEADLINE_MS = 30_000;

export interface IsrController {
  serve(path: string, render: IsrRenderFn): Promise<IsrServeResult>;
  /** Single-flight: concurrent callers for the same path share one render. */
  regenerate(path: string, render: IsrRenderFn): Promise<IsrEntry>;
  markStale(path: string): boolean;
  /**
   * Invalidate every ISR page carrying one of these tags — the ones the cache graph knows AND the
   * ones only the store holds — as each page's route declared: marked stale, or purged.
   */
  revalidateByTags(tags: readonly CacheTag[]): readonly string[];
  inflight(): number;
  store(): IsrStore;
  /**
   * Register this controller as the framework's revalidator, so
   * `action({ cache: { invalidates: [tag.post] } })` reaches ISR in the same hop as
   * memo, LRU, Redis and the CDN. Returns a detach function for tests and reloads.
   */
  attach(): () => void;
}

/**
 * `@ultimat3/cache` holds ONE revalidator and offers no read back, so detaching has to know
 * whether the slot is still this controller's — a controller that attached after it owns it now.
 */
let installedRevalidator: Revalidator | undefined;

/** What `registerRevalidator` is handed on detach: the framework's "nothing to revalidate". */
const NO_REVALIDATION: Revalidator = () => undefined;

export function isrController(options: IsrControllerOptions = {}): IsrController {
  const store = options.store ?? memoryIsrStore();
  const now = options.now ?? (() => Date.now());
  const routes = options.routes ?? describePages;
  const isrDependents =
    options.isrDependents ?? ((tags: readonly CacheTag[]) => dependentsOfKind(tags, 'isr-route'));
  const buildId = options.buildId ?? 'dev';
  const flight = singleFlight({
    deadlineMs: finiteCount(
      'isrController',
      'regenerateDeadlineMs',
      options.regenerateDeadlineMs ?? DEFAULT_ISR_REGENERATE_DEADLINE_MS,
      1,
    ),
    schedule: options.schedule,
  });
  /**
   * The newest regeneration STARTED per path, by identity. Once a deadline can evict a flight, two
   * renders of one path can overlap, and the older one settling last would publish its HTML over
   * the newer page with a fresh `generatedAt`. Cleared by the run that still owns it; a run that
   * never settles leaves one entry, replaced by the next regeneration of that path.
   */
  const latest = new Map<string, object>();
  const registered = new Set<string>();

  const descriptorFor = (key: string): RouteDescriptor | undefined => isrRouteFor(routes(), key);

  /**
   * A rendered page joins the invalidation graph under its route's tags, so `/blog/a` and
   * `/blog/b` are separately addressable and a `tag.post` bust does not touch `/team`.
   */
  function registerPath(path: string, descriptor: RouteDescriptor | undefined): void {
    if (descriptor === undefined || registered.has(path)) return;
    if (descriptor.revalidateTags.length === 0) return;
    registerDependent(descriptor.revalidateTags.map(parseWireTag), { kind: 'isr-route', id: path });
    registered.add(path);
  }

  function forgetPath(path: string): void {
    if (!registered.delete(path)) return;
    unregisterDependent({ kind: 'isr-route', id: path });
  }

  /**
   * A registration is only true while the store still holds the page. The store evicts silently
   * and offers no callback — and a custom `IsrStore` need not have one at all — so the store's own
   * `paths()` is the authority, reconciled after every generation. Left alone, `registered` and
   * the cache graph behind it only ever grew: `/blog/:slug` retains one edge per slug ever
   * requested, 404-shaped ones included, for the life of the process.
   */
  function forgetEvictedPaths(): void {
    if (registered.size === 0) return;
    const live = new Set(store.paths());
    for (const path of registered) if (!live.has(path)) forgetPath(path);
  }

  function isFresh(entry: IsrEntry): boolean {
    if (entry.stale) return false;
    const ttlMs = entryTtlMs(entry);
    if (ttlMs === null) return true; // tag-only revalidation: fresh until invalidated
    return now() - entry.generatedAt < ttlMs;
  }

  /**
   * `revalidate.maxStale`: past its TTL by more than the route allows, a copy is not an answer any
   * more. Without a bound, stale-while-revalidate serves the stored page ONCE MORE however old it
   * is — a page nobody asked for in a week answers its next visitor with last week's document.
   */
  function pastMaxStale(entry: IsrEntry, policy: IsrPolicy): boolean {
    const ttlMs = entryTtlMs(entry);
    if (policy.maxStaleMs === null || ttlMs === null) return false;
    return now() - entry.generatedAt >= ttlMs + policy.maxStaleMs;
  }

  /** One regeneration of `path`; `led` is told when THIS call started it rather than joined one. */
  function generate(path: string, render: IsrRenderFn, led?: () => void): Promise<Generation> {
    return flight.run(path, async (): Promise<Generation> => {
      led?.();
      const run = {};
      latest.set(path, run);
      const descriptor = descriptorFor(path);
      const policy = isrPolicyOf(descriptor);
      try {
        // BEFORE the render, not after: `revalidateByTags` reads the graph, so a bust arriving
        // while a cold path's first render was in flight could not see the page it was
        // invalidating — which is the window in which the bust that matters most arrives.
        registerPath(path, descriptor);
        // Sampled before the render for the reason `@ultimat3/cache`'s read-through fill samples
        // before its `load()` (`tiers.ts`): the HTML below is built from rows read in the past,
        // and a `markStale` landing in between was then ERASED by `store.set({ stale: false })`.
        // For a tag-only route `isFresh` is true forever, so the process went on serving pre-write
        // HTML for the rest of its life. One mechanism, not a second one grown here.
        const fence = sampleFence({ key: path, tags: policy.tags });
        const rendered = renderedOf(await render(path));
        const entry: IsrEntry = {
          path,
          html: rendered.html,
          hash: contentHash(rendered.html),
          generatedAt: now(),
          ttlMs: policy.ttlMs,
          stale: false,
          // Screened at generation, the one place a status enters the store: a `NaN` written here
          // would be served for the whole TTL as a `RangeError` on every hit.
          status: finiteStatus('IsrRenderFn', rendered.status),
        };
        const current = latest.get(path) === run;
        const failed = isServerError(rendered.status);
        // Kept only when nothing invalidated the page while it rendered and no newer run started.
        const kept = !failed && rendered.noStore !== true && fence.isValid() && current;
        if (failed) {
          // Never stored, and never over a good copy: one upstream blip stored for the TTL plus a
          // stale serve was minutes of 503 for a read that recovered in a second. The copy the
          // store holds stays (still stale, so the next request tries again); a miss has none, and
          // answers this 5xx to its own request only.
          logger.warn('isr.render.unstored', { path, status: String(rendered.status) });
        } else if (rendered.noStore === true) {
          // The loader's answer is not a failure, so the copy held is no longer the page.
          if (current) store.delete(path);
        } else if (kept) {
          // Refused, never published stale-flagged, once the fence is void: the next request
          // re-renders from rows that now include the write, where a stored-but-stale entry would
          // serve this pre-write body once more. Refused too once a newer run started (`latest`).
          store.set(entry);
        }
        forgetEvictedPaths();
        // What the store did not keep, the edge may not keep either: a page rendered from rows
        // read BEFORE a purge would otherwise reach the CDN after the purge had already run there.
        return { entry, cacheable: kept };
      } finally {
        if (latest.get(path) === run) latest.delete(path);
      }
    });
  }

  async function regenerate(path: string, render: IsrRenderFn): Promise<IsrEntry> {
    return (await generate(path, render)).entry;
  }

  function markStale(path: string): boolean {
    // The mark is recorded whether or not the store holds the page: a regeneration already in
    // flight for a path this store has never held is exactly the case the fence above exists for,
    // and `invalidateTags`' own fanout only marks the TAGS.
    markInvalidated({ key: path });
    return store.markStale(path);
  }

  /**
   * What a tag bust does to one page, as its route declared (`revalidate.onInvalidate`). `'purge'`
   * DELETES: the next request is a miss that renders and blocks, where `'stale'` answers the copy
   * once more, however old — the right trade for a price list, and the wrong one for an article
   * that was withdrawn. The fence is voided either way, so a render in flight cannot put it back.
   */
  function invalidate(path: string): void {
    if (isrPolicyOf(descriptorFor(path)).onInvalidate !== 'purge') {
      markStale(path);
      return;
    }
    markInvalidated({ key: path });
    store.delete(path);
    forgetPath(path);
  }

  /**
   * The keys the STORE holds under these tags, asked of the store and the route table rather than
   * of the graph. The graph is this process's memory of what it rendered: an entry another
   * controller wrote into a shared store, or one that outlived a restart, has no edge here, so a
   * bust that read only the graph left it standing — and under `'purge'` that is the withdrawn
   * page, still served. No route carrying the tags is the common case, and costs no store read.
   */
  function heldUnder(tags: readonly CacheTag[]): readonly string[] {
    const table = routes();
    const owners = new Set(
      table.filter((route) => tagsIntersect(tags, route.revalidateTags.map(parseWireTag))),
    );
    if (owners.size === 0) return [];
    return store.paths().filter((key) => {
      const route = isrRouteFor(table, key);
      return route !== undefined && owners.has(route);
    });
  }

  function revalidateHeld(tags: readonly CacheTag[]): readonly string[] {
    const held = heldUnder(tags);
    for (const path of held) invalidate(path);
    return held;
  }

  return {
    store: () => store,
    inflight: () => flight.size,
    regenerate,
    markStale,

    async serve(path, render) {
      const descriptor = descriptorFor(path);
      const policy = isrPolicyOf(descriptor);
      const answer = (entry: IsrEntry, servedStale = false, cacheable = true): RenderResult =>
        isrResult(entry, { buildId, policy, servedStale, cacheable });
      let cached = store.get(path);
      if (cached !== undefined && pastMaxStale(cached, policy)) {
        store.delete(path);
        cached = undefined;
      }

      if (cached === undefined) {
        const made = await generate(path, render);
        const result = answer(made.entry, false, made.cacheable);
        return { state: 'miss', entry: made.entry, result, regenerating: false };
      }

      // A hit on a page ANOTHER controller rendered into a shared store joins the graph here, so
      // the report of the next bust names it; the bust itself reaches it through `heldUnder`.
      registerPath(path, descriptor);
      if (isFresh(cached)) {
        return { state: 'hit', entry: cached, result: answer(cached), regenerating: false };
      }

      // stale-while-revalidate: answer from the stale copy now, refresh behind the request.
      let started = false;
      void generate(path, render, () => {
        started = true;
      }).catch((error: unknown) => {
        // `renderThrowable`, never `.message`/`String()`: this `.catch` is the last frame under a
        // route's own render function, and `String()` raises on a null-prototype object — the
        // handler that exists to REPORT the failure became a second, unhandled rejection.
        logger.warn('isr.regenerate.failed', { path, error: renderThrowable(error) });
      });
      return { state: 'stale', entry: cached, result: answer(cached, true), regenerating: started };
    },

    revalidateByTags(tags) {
      const affected = new Set<string>(isrDependents(tags));
      for (const path of affected) invalidate(path);
      for (const path of revalidateHeld(tags)) affected.add(path);
      return [...affected].sort();
    },

    attach() {
      // The cache fanout owns the trigger; render owns only "what does an invalidation mean here".
      const revalidate: Revalidator = (path) => {
        invalidate(path);
      };
      const revalidateTags: TagRevalidator = (tags) => revalidateHeld(tags);
      registerRevalidator(revalidate, revalidateTags);
      installedRevalidator = revalidate;
      return () => {
        for (const path of registered) unregisterDependent({ kind: 'isr-route', id: path });
        registered.clear();
        // Left installed, this closure — and the whole store behind it — stayed reachable from
        // the cache graph and kept receiving revalidations. `x dev`'s hot reload detached A and
        // created B, and `invalidateTags` still called A's `markStale`: B's pages never went
        // stale and A's store was never collected. Only if the slot is still OURS: a controller
        // that attached after us owns it, and clearing that one is this bug pointed backwards.
        if (installedRevalidator === revalidate) {
          registerRevalidator(NO_REVALIDATION);
          installedRevalidator = undefined;
        }
      };
    },
  };
}

/**
 * The whole loop, in one call: `action({ cache: { invalidates: [tag.post] } })` fans out
 * across memo, LRU, Redis and the CDN, and the same hop returns the ISR pages that were
 * marked stale — because the controller registered them in the same graph. Nobody lists
 * pages by hand, so nobody forgets one.
 */
export async function invalidateAndRevalidate(
  tags: readonly CacheTag[],
): Promise<readonly string[]> {
  const report = await invalidateTags(tags);
  return report.isr;
}
