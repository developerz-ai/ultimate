// Single responsibility: the closed vocabularies a route is declared in — where it lives, how it
// renders, how it survives offline, when it hydrates. Tier 0 so every package that names one
// imports it.
// Deliberately not `config.ts`: `app.config.ts` CONSUMES `OfflineStrategy`, it does not own it.

/**
 * Each union is DERIVED from its array rather than written twice, so the pair cannot disagree:
 * the array is the one place a member is added or removed and the type follows.
 *
 * This module exists because the alternative was measured. Twelve declarations of these three sets
 * lived across six packages — `render` alone spelled `RenderMode` and `RENDER_MODES` separately —
 * and `'spa'` was deleted from one of them while five others went on admitting it under a green
 * project-wide typecheck. `@ultimat3/pwa`'s copy mapped `spa` to `cache-first`, the one strategy
 * that gives an `app/` route a SHARED cache entry: one member's authed HTML served to the next.
 * A copy is not a style question. `scripts/render-modes.test.ts` refuses a second declaration.
 */
export const RENDER_MODES = ['static', 'isr', 'ssr', 'stream'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export const OFFLINE_STRATEGIES = ['precache', 'runtime', 'network-only'] as const;
export type OfflineStrategy = (typeof OFFLINE_STRATEGIES)[number];

export const HYDRATE_STRATEGIES = ['idle', 'visible', 'interaction', 'never'] as const;
export type HydrateStrategy = (typeof HYDRATE_STRATEGIES)[number];

/**
 * The directories an app's code lives in: `site/` and `app/` hold routes, `api/` the projections
 * `defineApi()` collects, `shared/` what the others import. `@ultimat3/render` owns the boundary
 * between them (`SURFACE_SPECS`); `@ultimat3/seo` reads a route's. One declaration, here.
 */
export const SURFACES = ['site', 'app', 'api', 'shared'] as const;
export type Surface = (typeof SURFACES)[number];
