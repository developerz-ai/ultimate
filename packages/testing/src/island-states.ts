// The vocabulary for declaring the STATES one island can be photographed in — error, empty,
// over-quota, read-only: the ones a reviewer cannot reach by clicking. Types and constants only, so
// a `settings.island.states.ts` beside the island is readable without a browser or a bundle;
// `define-island-states.ts` is what validates one, and nothing here imports anything at all.

export const ISLAND_THEMES = ['light', 'dark'] as const;
export type IslandTheme = (typeof ISLAND_THEMES)[number];

/** What an address falls back to. A mistyped theme shows the component, never an error page. */
export const DEFAULT_ISLAND_THEME: IslandTheme = 'light';

export interface IslandViewport {
  readonly width: number;
  readonly height: number;
}

/** A laptop, not a phone: the state under review is the component's, not the breakpoint's. */
export const DEFAULT_ISLAND_VIEWPORT: IslandViewport = { width: 1280, height: 800 };

/**
 * The zone every picture is rendered in unless a manifest says otherwise. Pinned in the VOCABULARY
 * rather than left to the harness: a run that freezes the instant and leaves the zone ambient
 * renders `12:00` on one machine and `14:00` on the next, and the diff between two reviews then
 * says the component changed when only the reviewer moved.
 */
export const ISLAND_SHOT_TIME_ZONE = 'UTC';

export type IslandStubResponse =
  | { readonly kind: 'json'; readonly status?: number; readonly body: unknown }
  | { readonly kind: 'pending' }
  | { readonly kind: 'offline' };

export interface IslandRouteStub {
  /** `"<METHOD> <pathname>"`, matched as a PREFIX: `'GET /api/quota'` catches its query string. */
  readonly match: string;
  readonly respond: IslandStubResponse;
}

export interface IslandStateDecl {
  /** A slug. It becomes the screenshot filename stem, so it is guessable or it is nothing. */
  readonly id: string;
  /** One line: what this state IS. */
  readonly title: string;
  /** WHY it deserves a picture — usually "you cannot reach this by clicking, because …". */
  readonly note?: string;
  /** JSON, by construction: these ride the same `data-x-props` seam hydration already uses. */
  readonly props: Readonly<Record<string, unknown>>;
  /** Fixtures for whatever the component fetches on its own. */
  readonly routes?: readonly IslandRouteStub[];
  readonly viewport?: IslandViewport;
  /** Both, unless the state is only meaningful in one of them. */
  readonly themes?: readonly IslandTheme[];
}

export interface IslandStatesDecl {
  /** App-root-relative path of the `.island.tsx` these states belong to. */
  readonly island: string;
  readonly states: readonly IslandStateDecl[];
  readonly viewport?: IslandViewport;
  /** CSS selector to crop to. The island's host element when absent. */
  readonly target?: string;
  /** IANA zone. `UTC` unless the state under review is about a zone. */
  readonly timeZone?: string;
  /** The frozen instant, with an explicit offset. The suite's own `DEFAULT_NOW` when absent. */
  readonly now?: string;
}

/** A declared state with every default resolved — what a target is expanded from. */
export interface IslandState {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly routes: readonly IslandRouteStub[];
  readonly viewport: IslandViewport;
  readonly themes: readonly IslandTheme[];
}

/**
 * Registered globally so two copies of this module agree on what a manifest is — the same reason
 * `@ultimat3/render`'s island node carries one. It is what lets a loader read an app's states file
 * and tell a manifest from every other export in it without trusting a name.
 */
export const ISLAND_STATES: unique symbol = Symbol.for('ultimate.testing.island-states') as never;

export interface IslandStatesManifest {
  readonly [ISLAND_STATES]: true;
  /** Derived from the island's own filename: the shot directory, and the name a reader types. */
  readonly name: string;
  readonly island: string;
  readonly states: readonly IslandState[];
  readonly viewport: IslandViewport;
  readonly target?: string;
  readonly timeZone: string;
  readonly now: string;
}

export function isIslandStatesManifest(value: unknown): value is IslandStatesManifest {
  return typeof value === 'object' && value !== null && ISLAND_STATES in value;
}

/**
 * `apps/web/app/settings/settings.island.tsx` → `settings`. The basename up to its FIRST dot, so
 * the island extension is never restated in this package — it is `@ultimat3/render`'s constant and
 * a second copy of it here is a second thing to keep in step.
 */
export function islandStatesName(island: string): string {
  const base = island.split('/').pop() ?? island;
  return (base.split('.')[0] ?? base).toLowerCase();
}
