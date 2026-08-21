/**
 * The four render modes as a table of invariants, checked at registration.
 * Each mode has properties the framework can rely on; a config that contradicts one is
 * rejected with `X_ROUTE_MODE_INVALID` and the exact edit that fixes it. A mode whose
 * invariant is only documented is a mode that silently degrades in production.
 */

import type { HydrateStrategy, RenderMode } from '@ultimat3/core';
import { HYDRATE_STRATEGIES, RENDER_MODES } from '@ultimat3/core';
import { parseTtlMs } from './duration';
import { RouteModeInvalidError } from './errors';
import type { RouteConfig } from './route';
import type { Surface } from './surfaces';
import { SURFACE_SPECS, surfaceAllows } from './surfaces';

/**
 * Everything about a route except the two keys carrying its data generic. Mode invariants never
 * read metadata and never load anything, and omitting both keeps these checks free of `TData`.
 *
 * Not a convenience — a requirement. Both are function-typed *properties*, so they are checked
 * contravariantly: keeping either here makes `RouteConfig<TData>` unassignable to `RouteShape`
 * for every `TData` other than the default, and `assertModeShape(config)` stops compiling inside
 * `defineRoute` itself. Same variance trap that `Invariant.holds` hit in `@ultimat3/entity`.
 */
export type RouteShape = Omit<RouteConfig, 'meta' | 'load'>;

export interface ModeSpec {
  readonly mode: RenderMode;
  /** May the render function observe the request (actor, headers, cookies, geo)? */
  readonly perRequestState: boolean;
  /** May the route be built ahead of time via `prerender()`? */
  readonly prerenderable: boolean;
  /** Does the mode need a revalidation trigger (tags or TTL)? */
  readonly needsRevalidate: boolean;
  /** Does the mode need at least one `<Suspense>` boundary to mean anything? */
  readonly needsSuspense: boolean;
  readonly description: string;
}

/** Keyed with an explicit type argument for the reason `MODE_STRATEGY` in `@ultimat3/pwa`
 * gives: a `const X: Record<…> = Object.freeze({…})` accepts an extra key in silence. */
export const MODE_SPECS = Object.freeze<Record<RenderMode, ModeSpec>>({
  static: {
    mode: 'static',
    perRequestState: false,
    prerenderable: true,
    needsRevalidate: false,
    needsSuspense: false,
    description: 'built once, served as a file',
  },
  isr: {
    mode: 'isr',
    perRequestState: false,
    prerenderable: true,
    needsRevalidate: true,
    needsSuspense: false,
    description: 'static + background regen on tag/TTL',
  },
  ssr: {
    mode: 'ssr',
    perRequestState: true,
    prerenderable: false,
    needsRevalidate: false,
    needsSuspense: false,
    description: 'per-request full render',
  },
  stream: {
    mode: 'stream',
    perRequestState: true,
    prerenderable: false,
    needsRevalidate: false,
    needsSuspense: true,
    description: 'static shell flushed instantly, holes streamed',
  },
});

/** Mode-local checks that need nothing but the config. Called by `defineRoute`. */
export function assertModeShape(config: RouteShape): void {
  // Widened on purpose: JS callers reach `defineRoute` with unvalidated strings — and an object
  // lookup walks the prototype chain, so `render: 'constructor'` used to find a `ModeSpec` that
  // does not exist and hand back a frozen descriptor for a mode nothing implements.
  const spec: ModeSpec | undefined = Object.hasOwn(MODE_SPECS, config.render)
    ? MODE_SPECS[config.render]
    : undefined;
  if (spec === undefined) {
    throw new RouteModeInvalidError(
      `render: ${JSON.stringify(config.render)} is not a render mode`,
      `use one of ${RENDER_MODES.join(' | ')}`,
    );
  }

  if (!HYDRATE_STRATEGIES.includes(config.hydrate)) {
    throw new RouteModeInvalidError(
      `hydrate: ${JSON.stringify(config.hydrate)} is not a hydration strategy`,
      `use one of ${HYDRATE_STRATEGIES.join(' | ')}`,
    );
  }

  // static: no per-request state. `policy` needs an actor and `revalidate` needs a
  // request to regenerate on — both mean the page is not a file on disk.
  if (config.render === 'static' && config.policy !== undefined) {
    throw new RouteModeInvalidError(
      "render: 'static' cannot read per-request state, but a `policy` was declared " +
        `(${config.policy.permission} needs an actor)`,
      "change render to 'ssr' — per-request and gated — or drop the policy",
    );
  }
  if (config.render === 'static' && config.revalidate !== undefined) {
    throw new RouteModeInvalidError(
      "render: 'static' is built once and never regenerates, but `revalidate` was declared",
      "change render to 'isr' to keep the revalidate trigger",
    );
  }

  // isr: a CACHED document, so it may not be gated. The symmetry with `static` above is the
  // point — an ISR route resolves `load` with the request's own `Ctx`, renders that actor's
  // document, and the cache stores it under the pathname alone. Every later actor who passes the
  // same policy is then served the first actor's HTML. Keying the cache on more is a trap, not a
  // fix: the key would have to enumerate everything a policy and a `load` can read.
  if (config.render === 'isr' && config.policy !== undefined) {
    throw new RouteModeInvalidError(
      "render: 'isr' caches one document per URL and cannot be gated, but a `policy` was " +
        `declared (${config.policy.permission} varies the answer per actor)`,
      "change render to 'ssr' — per-request and gated — or drop the policy",
    );
  }

  // isr: needs a trigger, otherwise it is `static` wearing a costume.
  if (config.render === 'isr' && !hasRevalidateTrigger(config)) {
    throw new RouteModeInvalidError(
      "render: 'isr' requires a regeneration trigger, but revalidate has neither tags nor ttl",
      "add revalidate: { tags: [tag.post] } or revalidate: { ttl: '5m' }",
    );
  }

  // ssr: cannot be prerendered — the whole point is that it runs per request.
  if (config.render === 'ssr' && config.prerender !== undefined) {
    throw new RouteModeInvalidError(
      "render: 'ssr' renders per request and cannot be prerendered, but `prerender` was declared",
      "change render to 'isr' to prerender and regenerate, or remove prerender",
    );
  }
}

function hasRevalidateTrigger(config: RouteShape): boolean {
  const revalidate = config.revalidate;
  if (revalidate === undefined) return false;
  const hasTags = revalidate.tags !== undefined && revalidate.tags.length > 0;
  // `parseTtlMs`, never "a non-empty string": the ISR clock is the one that has to read this value,
  // and `ttl: '5 minutes'` passed here and parsed to `null` there — a page generated once and
  // served for the life of the process, which is the exact costume this check refuses below.
  const hasTtl = parseTtlMs(revalidate.ttl) !== null;
  return hasTags || hasTtl;
}

export interface ModeCheckContext {
  readonly file: string;
  readonly path: string;
  readonly surface: Surface;
  /** Counted from the route module's JSX by the build. `stream` needs at least one. */
  readonly suspenseBoundaries: number;
}

/** Checks that need the surrounding module and surface. Called by `registerRoute`. */
export function assertModeInvariants(config: RouteShape, ctx: ModeCheckContext): void {
  if (ctx.surface === 'api') {
    throw new RouteModeInvalidError(
      `${ctx.file} is in api/, which renders nothing, but declares render: '${config.render}'`,
      `move ${ctx.file} into site/ or app/, or replace defineRoute with an action`,
    );
  }

  if (!surfaceAllows(ctx.surface, config.render)) {
    const allowed = SURFACE_SPECS[ctx.surface].allowedModes.join(' | ');
    throw new RouteModeInvalidError(
      `${ctx.file} is in ${ctx.surface}/ and declares render: '${config.render}', ` +
        `which ${ctx.surface}/ does not allow`,
      `use one of ${allowed} in ${ctx.file}`,
    );
  }

  // `budget` is always on the descriptor; `budget.js` is the field that stays optional,
  // and its absence is the failure — site/ is 0kb until a route says otherwise, in bytes.
  if (ctx.surface === 'site' && config.hydrate !== 'never' && config.budget.js === undefined) {
    throw new RouteModeInvalidError(
      `${ctx.file} is in site/ (0kb JS baseline) and opts into hydrate: '${config.hydrate}' ` +
        'without a JS budget',
      `add budget: { js: '10kb' } to ${ctx.file} — hydration on site/ is explicit and budgeted`,
    );
  }

  if (config.render === 'stream' && ctx.suspenseBoundaries < 1) {
    throw new RouteModeInvalidError(
      `${ctx.file} declares render: 'stream' but has no <Suspense> boundary, so there is ` +
        'nothing to stream — the whole page waits like ssr',
      `wrap the data-dependent part of ${ctx.file} in <Suspense fallback={…}> ` +
        "or change render to 'ssr'",
    );
  }

  if (config.prerender !== undefined && !MODE_SPECS[config.render].prerenderable) {
    throw new RouteModeInvalidError(
      `${ctx.file} declares prerender with render: '${config.render}', which is not prerenderable`,
      `remove prerender from ${ctx.file} or change render to 'static' | 'isr'`,
    );
  }
}

/** Default hydration timing per surface — `site/` ships nothing unless asked. */
export function defaultHydrate(surface: Surface): HydrateStrategy {
  return surface === 'site' ? 'never' : 'idle';
}

/**
 * What an island route may spend ABOVE its surface's baseline when it declares no `budget.js` —
 * the island chunk plus the hydration runtime, which is what `routeJsBytes` adds to the baseline.
 *
 * **20kb, and it is calibrated on a Solid island** (`As of 2026-08-21`). It was 4096, justified in
 * this comment as "twice what the reference app's real island costs (875 B of chunk plus a 1,019 B
 * runtime)" — and that island, `contact-sales.island.tsx`, imports no `solid-js` at all. Calibrating
 * a JSX budget on the one island shape that does not pay the JSX runtime made the default
 * unreachable for every island that does: measured with `buildIslands`, minified, production Solid,
 * `render(() => <p>hello</p>, el)` is **12,588 B** — the floor, before an author writes anything —
 * a signal + a button + reactive text is 13,663 B, and the reference app's real Solid island
 * (`settings.island.tsx`) is 17,797 B. No `budget.js` under 4096 was reachable by any of them, on
 * any surface, because the allowance is measured above the baseline and not against it.
 *
 * The number: 17,797 (the heaviest island this repo actually ships) + 615 (`hydrateRuntimeBytes`
 * for one directive) = 18,412, rounded up to the next whole kilobyte with headroom. It is not
 * derived from Solid's own size on purpose — this package may not import or name `solid-js`
 * (`CLAUDE.md`), so a constant tracking the runtime's version would be a dependency in a comment.
 *
 * Still a real ceiling, still real bytes on disk: an island that pulls a design system in
 * (`@ultimat3/ui`'s `<Switch>` measures 36,335 B) or ships an engine twice must write its own
 * number down, which is the whole point. Two defaults keyed on "does the graph reach Solid?" is
 * not an option even setting axiom 1 aside: `registry.ts` reads this at REGISTRATION, before any
 * bundle exists, so the answer is not available where the constant is used.
 */
export const DEFAULT_ISLAND_JS_BYTES = 20_480;

/**
 * The derived ceiling for a route whose hydration came from an island. Relative to the surface
 * baseline, never absolute: `site/` starts at 0kb and `app/` at 14kb, so one number would be
 * either a ceiling `app/` fails on arrival or one `site/` can never reach.
 */
export function defaultIslandBudget(surface: Surface): string {
  const bytes = SURFACE_SPECS[surface].jsBaselineBytes + DEFAULT_ISLAND_JS_BYTES;
  return `${bytes / 1024}kb`;
}
