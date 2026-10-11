/**
 * The ISR controller's contract: what a render hands it, what a request gets back, what it can be
 * built with and what it offers. Declarations only — `render-isr.ts` is the controller.
 */

import type { CacheFence, CacheTag, FenceScope } from '@ultimat3/cache';
import type { Scheduler } from '@ultimat3/core';
import type { RouteDescriptor } from './registry';
import type { IsrEntry, IsrState, IsrStore } from './render-isr-store';
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

/** One regeneration's outcome: the entry it rendered, and whether that entry was kept. */
export interface Generation {
  readonly entry: IsrEntry;
  readonly cacheable: boolean;
  /**
   * A page that WOULD have been kept, refused because something invalidated it while it rendered.
   * The request that led the render predates that and is answered it, uncached; a request that
   * merely joined may have arrived after, so it renders for itself (`serve`).
   */
  readonly fenced: boolean;
}

/**
 * The process fence a controller samples and marks — `@ultimat3/cache`'s, by default. A seam so
 * two controllers in one test can stand for two PROCESSES: sharing the real one made every
 * shared-store test pass on a fence two replicas never share.
 */
export interface IsrFence {
  sample(scope: FenceScope): CacheFence;
  mark(scope: FenceScope): void;
}

export type IsrRenderFn = (path: string) => string | IsrRendered | Promise<string | IsrRendered>;

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
  /** See `IsrFence`. Defaults to the process's own. */
  readonly fence?: IsrFence | undefined;
  /**
   * How long a 5xx render answers the requests behind it instead of each rendering again, in
   * whole ms. Defaults to `DEFAULT_ISR_FAILURE_COOLDOWN_MS`; `0` renders on every request.
   */
  readonly failureCooldownMs?: number | undefined;
}

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
