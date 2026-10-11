/**
 * `isr` — static output plus background regeneration. Three things make it safe:
 * stale-while-revalidate (a stale page is served instantly, never a spinner),
 * single-flight regeneration (a traffic burst on a stale page renders once, not N times),
 * and tag-driven staleness (an action's `invalidates` marks exactly the dependent routes).
 */

import type { CacheTag, Revalidator, TagRevalidator } from '@ultimat3/cache';
import {
  dependentsOfKind,
  EVERY_TAG,
  invalidateTags,
  markInvalidated,
  registerDependent,
  registerRevalidator,
  sampleFence,
  tagsIntersect,
  unregisterDependent,
} from '@ultimat3/cache';
import { finiteCount, logger, renderThrowable, singleFlight } from '@ultimat3/core';
import { finiteStatus } from './finite-status';
import type { RouteDescriptor } from './registry';
import { describePages } from './registry';
import { DEFAULT_ISR_FAILURE_COOLDOWN_MS, failureCooldown } from './render-isr-cooldown';
import { entryTtlMs, isrResult } from './render-isr-result';
import type { IsrPolicy } from './render-isr-routes';
import { isrPolicyOf, isrRouteFor, parseWireTag } from './render-isr-routes';
import type { IsrEntry } from './render-isr-store';
import { memoryIsrStore } from './render-isr-store';
import type {
  Generation,
  IsrController,
  IsrControllerOptions,
  IsrFence,
  IsrRendered,
  IsrRenderFn,
} from './render-isr-types';
import { contentHash } from './render-static';
import type { RenderResult } from './route';

/**
 * The ceiling on one regeneration's hold on its path — `@ultimat3/http`'s default
 * `requestTimeoutMs`, so the request that started a render has been cut off by then. Without it,
 * one `render()` that never settled pinned its path for the life of the process: a missed page
 * hung every later request, a stale one was served stale forever, and only a restart cleared it.
 * Eviction frees the PATH; the hung render is not cancellable from here, and its late result is
 * dropped if a newer regeneration has started since (`latest`).
 */
export const DEFAULT_ISR_REGENERATE_DEADLINE_MS = 30_000;

/** A 5xx is the app's "the read failed, ask again" — an answer about a moment, never a document. */
const isServerError = (status: number): boolean => status >= 500;

const PROCESS_FENCE: IsrFence = { sample: sampleFence, mark: markInvalidated };

/** The store's fence is keyed by tag ENTITY: `post` for `post` and `post:1` alike. */
const entitiesOf = (tags: readonly CacheTag[]): readonly string[] =>
  [...new Set(tags.map((one) => one.entity))].sort();

/** One shape for the generator, so nothing below branches on what the render handed back. */
function renderedOf(rendered: string | IsrRendered): IsrRendered {
  return typeof rendered === 'string' ? { html: rendered, status: 200 } : rendered;
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
  const fences = options.fence ?? PROCESS_FENCE;
  const failed = failureCooldown<Generation>(
    finiteCount(
      'isrController',
      'failureCooldownMs',
      options.failureCooldownMs ?? DEFAULT_ISR_FAILURE_COOLDOWN_MS,
    ),
    now,
  );

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
    // A page whose FIRST render is still running is in no store yet and is not evicted: forgotten
    // here, a bust arriving before it settled found it in neither the graph nor the store.
    const live = new Set([...store.paths(), ...flight.keys()]);
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
        const fence = fences.sample({ key: path, tags: policy.tags });
        // And the STORE's own fence, for a store another process writes: read before the rows are.
        const entities = entitiesOf(policy.tags);
        const reading = store.tagFence?.sample(entities);
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
        const unstorable = isServerError(rendered.status) || rendered.noStore === true;
        // Kept only when nothing invalidated the page while it rendered — in this process (the
        // fence) or in any other (the store's) — and no newer run started. Refused, never
        // published stale-flagged: the next request re-renders from rows that include the write.
        const kept = !unstorable && fence.isValid() && current && write(entry, entities, reading);
        if (isServerError(rendered.status)) {
          // Never stored, and never over a good copy: one upstream blip stored for the TTL plus a
          // stale serve was minutes of 503 for a read that recovered in a second. The copy the
          // store holds stays (still stale, so the next request tries again); a miss has none, and
          // answers this 5xx to its own request only.
          logger.warn('isr.render.unstored', { path, status: String(rendered.status) });
        } else if (rendered.noStore === true) {
          // The loader's answer is not a failure, so the copy held is no longer the page.
          if (current) store.delete(path);
        }
        forgetEvictedPaths();
        // What the store did not keep, the edge may not keep either: a page rendered from rows
        // read BEFORE a purge would otherwise reach the CDN after the purge had already run there.
        return { entry, cacheable: kept, fenced: !unstorable && !kept };
      } finally {
        if (latest.get(path) === run) latest.delete(path);
      }
    });
  }

  /** The one write: through the store's own fence when it has one, so a stale reading is refused. */
  function write(
    entry: IsrEntry,
    entities: readonly string[],
    reading: string | undefined,
  ): boolean {
    if (store.tagFence === undefined || reading === undefined) {
      store.set(entry);
      return true;
    }
    return store.tagFence.setIfCurrent(entry, entities, reading);
  }

  /**
   * A generation FOR one request. A request that joined a render someone else started may have
   * arrived after the bust that fenced it, so it does not take that page: it renders once more,
   * and by then the fenced flight has settled, so this one began after the bust. A 5xx is
   * remembered for the cooldown, so the requests right behind it are not each a failing render.
   */
  async function generateFor(path: string, render: IsrRenderFn): Promise<Generation> {
    let led = false;
    const lead = (): void => {
      led = true;
    };
    const joined = await generate(path, render, lead);
    const made = !led && joined.fenced ? await generate(path, render) : joined;
    if (isServerError(made.entry.status ?? 200)) failed.remember(path, made);
    return made;
  }

  async function regenerate(path: string, render: IsrRenderFn): Promise<IsrEntry> {
    return (await generate(path, render)).entry;
  }

  function markStale(path: string): boolean {
    // The mark is recorded whether or not the store holds the page: a regeneration already in
    // flight for a path this store has never held is exactly the case the fence above exists for,
    // and `invalidateTags`' own fanout only marks the TAGS.
    fences.mark({ key: path });
    return store.markStale(path);
  }

  /**
   * What a tag bust does to one page, as its route declared (`revalidate.onInvalidate`). `'purge'`
   * DELETES: the next request is a miss that renders and blocks, where `'stale'` answers the copy
   * once more, however old — the right trade for a price list, and the wrong one for an article
   * that was withdrawn. The fence is voided either way, so a render in flight cannot put it back —
   * and its FLIGHT is evicted, so a request arriving after this call leads a render of its own
   * instead of joining one that read its rows before the write (up to the 30 s deadline of them).
   */
  function invalidate(path: string): void {
    failed.clear(path);
    flight.evict(path);
    if (isrPolicyOf(descriptorFor(path)).onInvalidate !== 'purge') {
      markStale(path);
      return;
    }
    fences.mark({ key: path });
    store.delete(path);
    forgetPath(path);
  }

  /**
   * Everything HELD under these tags, asked of the store, the flights and the route table rather
   * than of the graph. The graph is this process's memory of what it rendered: an entry another
   * controller wrote into a shared store, one that outlived a restart, or a cold page whose first
   * render is still running, has no edge there — and under `'purge'` that is the withdrawn page,
   * still served. No route carrying the tags is the common case, and costs no store read.
   *
   * By ROUTE tags: a row bust (`post:1`) reaches every stored page of a route tagged `post`. An
   * entry records no tags of its own, so this errs toward one render too many, never one too few.
   */
  function revalidateHeld(tags: readonly CacheTag[] | typeof EVERY_TAG): readonly string[] {
    const table = routes();
    // A flush (`EVERY_TAG`) is a bust of every tag at once: every route that carries one owns.
    const owns = (route: RouteDescriptor): boolean =>
      tags === EVERY_TAG
        ? route.revalidateTags.length > 0
        : tagsIntersect(tags, route.revalidateTags.map(parseWireTag));
    const owners = new Set(table.filter(owns));
    if (owners.size === 0) return [];
    const owned = (key: string): boolean => {
      const route = isrRouteFor(table, key);
      return route !== undefined && owners.has(route);
    };
    // The store's fence FIRST: a write racing this call from another process is refused from here.
    const busted =
      tags === EVERY_TAG ? [...owners].flatMap((r) => r.revalidateTags.map(parseWireTag)) : tags;
    store.tagFence?.bump(entitiesOf(busted));
    for (const key of flight.keys()) if (owned(key)) invalidate(key);
    const held = store.paths().filter(owned);
    // A page the graph already named was marked a moment ago; it is reported, not marked twice.
    for (const path of held) if (store.get(path)?.stale !== true) invalidate(path);
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
        isrResult(entry, {
          buildId,
          policy,
          servedStale,
          cacheable,
          ageMs: Math.max(0, now() - entry.generatedAt),
        });
      let cached = store.get(path);
      if (cached !== undefined && pastMaxStale(cached, policy)) {
        store.delete(path);
        cached = undefined;
      }

      if (cached === undefined) {
        const made = failed.get(path) ?? (await generateFor(path, render));
        const result = answer(made.entry, false, made.cacheable);
        return { state: 'miss', entry: made.entry, result, regenerating: false };
      }

      // A hit on a page ANOTHER controller rendered into a shared store joins the graph here, so
      // the report of the next bust names it; the bust itself reaches it through `heldUnder`.
      registerPath(path, descriptor);
      if (isFresh(cached)) {
        return { state: 'hit', entry: cached, result: answer(cached), regenerating: false };
      }

      // stale-while-revalidate: answer from the stale copy now, refresh behind the request —
      // unless the last refresh just failed, which the next one a moment later would repeat.
      let started = false;
      if (failed.get(path) !== undefined) {
        return { state: 'stale', entry: cached, result: answer(cached, true), regenerating: false };
      }
      void generate(path, render, () => {
        started = true;
      })
        .then((made) => {
          if (isServerError(made.entry.status ?? 200)) failed.remember(path, made);
        })
        .catch((error: unknown) => {
          // `renderThrowable`, never `.message`/`String()`: this `.catch` is the last frame under a
          // route's own render function, and `String()` raises on a null-prototype object — the
          // handler that exists to REPORT the failure became a second, unhandled rejection.
          logger.warn('isr.regenerate.failed', { path, error: renderThrowable(error) });
        });
      return { state: 'stale', entry: cached, result: answer(cached, true), regenerating: started };
    },

    revalidateByTags(tags) {
      // By TAG first, as `invalidateTags` does before it calls in here: a cold page whose first
      // render is running may be in neither the graph nor the store, and only its fence finds it.
      fences.mark({ tags });
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
