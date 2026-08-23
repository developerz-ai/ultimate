// The expansion: one manifest in, one record per PICTURE out. Pure, and deliberately total — the
// command that photographs them knows the complete expected file list before a browser exists, so
// "produced nothing and exited 0" is a state it can refuse rather than a state it can report.

import type { IslandStatesManifest, IslandTheme, IslandViewport } from './island-states';
import { DEFAULT_ISLAND_THEME, ISLAND_THEMES } from './island-states';

export interface IslandShotTarget {
  /** App-root-relative path of the `.island.tsx`, as the manifest declared it. */
  readonly island: string;
  /** The manifest's own name — the shot directory, and what a reader types to ask for it. */
  readonly name: string;
  readonly state: string;
  readonly theme: IslandTheme;
  readonly viewport: IslandViewport;
  /** CSS selector to crop to. Absent means the island's host element. */
  readonly target?: string;
  readonly timeZone: string;
  readonly now: string;
  /** `<name>/<state>-<theme>.png` — flat and mechanical, because the reader GUESSES this path. */
  readonly file: string;
  /** The harness address that renders exactly this picture. `parseIslandAddress` is its inverse. */
  readonly query: string;
}

export const islandShotFile = (name: string, state: string, theme: IslandTheme): string =>
  `${name}/${state}-${theme}.png`;

export interface IslandAddress {
  readonly island: string;
  readonly state: string;
  readonly theme: IslandTheme;
}

/**
 * The address as a query string, `?` included, so it appends to any harness URL. Ordered
 * island → state → theme and never sorted: an address is read by people as often as by code.
 */
export function islandAddress(address: IslandAddress): string {
  const params = new URLSearchParams([
    ['island', address.island],
    ['state', address.state],
    ['theme', address.theme],
  ]);
  return `?${params.toString()}`;
}

/**
 * The inverse, made TOTAL. Every failure falls back rather than throwing: a mistyped theme, a
 * missing key or an empty string all still answer an address, because the harness that reads this
 * is a page — and a page that renders an error instead of the component turns a typo into a
 * screenshot of the framework. The one refusal in this design is `findIslandStates`, which names
 * every valid island when it cannot resolve one.
 */
export function parseIslandAddress(query: string): IslandAddress {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const theme = params.get('theme');
  return {
    island: params.get('island') ?? '',
    state: params.get('state') ?? '',
    theme: isIslandTheme(theme) ? theme : DEFAULT_ISLAND_THEME,
  };
}

export function isIslandTheme(value: unknown): value is IslandTheme {
  return typeof value === 'string' && ISLAND_THEMES.includes(value as IslandTheme);
}

/**
 * Every picture this manifest asks for, state by state and theme by theme in declaration order.
 * `selector` is the caller's override for the manifest's own `target` — a flag beats a file — and
 * absent means "whatever the manifest said", never "crop nothing".
 */
export function islandShotTargets(
  manifest: IslandStatesManifest,
  selector?: string,
): readonly IslandShotTarget[] {
  const target = selector ?? manifest.target;
  return manifest.states.flatMap((state) =>
    state.themes.map((theme) => ({
      island: manifest.island,
      name: manifest.name,
      state: state.id,
      theme,
      viewport: state.viewport,
      ...(target === undefined ? {} : { target }),
      timeZone: manifest.timeZone,
      now: manifest.now,
      file: islandShotFile(manifest.name, state.id, theme),
      query: islandAddress({ island: manifest.island, state: state.id, theme }),
    })),
  );
}

/** The same expansion over a whole set, in the order the manifests arrived. */
export function islandShotPlan(
  manifests: readonly IslandStatesManifest[],
  selector?: string,
): readonly IslandShotTarget[] {
  return manifests.flatMap((manifest) => islandShotTargets(manifest, selector));
}
