// The dashboard's facts, apart from its markup: pure projections of what the framework registered,
// so the page and a test read the same shape. No I/O, no `t()`, no JSX.

/** The three columns of the route table, as `x routes` prints them. */
export interface RouteRow {
  readonly path: string;
  readonly surface: string;
  readonly render: string;
}

/** What `routeEntries()` hands over, narrowed to the fields the table reads. */
export interface RouteLike {
  readonly path: string;
  readonly surface: string;
  readonly config: { readonly render: string };
}

/** Sorted by path in code-unit order — the order `x routes` and the manifest both use. */
export const routeRows = (entries: readonly RouteLike[]): readonly RouteRow[] =>
  entries
    .map((entry) => ({ path: entry.path, surface: entry.surface, render: entry.config.render }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

export interface FrameworkFacts {
  readonly routes: number;
  readonly locales: number;
  readonly roles: number;
  readonly version: string;
}

/** Counts are never negative, and a blank version is reported as unknown rather than as nothing. */
export const factsOf = (input: FrameworkFacts): FrameworkFacts => ({
  routes: Math.max(0, input.routes),
  locales: Math.max(0, input.locales),
  roles: Math.max(0, input.roles),
  version: input.version === '' ? 'unknown' : input.version,
});

/** A figure for a tile, in the page's locale. `Intl.NumberFormat` needs no time zone. */
export const formatCount = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale).format(value);
