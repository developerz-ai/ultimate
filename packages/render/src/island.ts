/**
 * The island: one interactive component on an otherwise static page.
 *
 * Declared by module SPECIFIER, never by import — a string cannot close over a database handle,
 * and there is no import edge for a bundler to follow, so a static page's graph stays the page's
 * graph (axiom 6). WHEN it wakes is the route's `hydrate`, never a second declaration here.
 */

import { IslandInvalidError } from './errors';
import type { JsonValue } from './island-props';
import type { JsxProps } from './jsx';

/**
 * One spelling, like `page.tsx` and `route.ts`: a file is a client entry if and only if its name
 * says so. That is what makes "what ships JS?" answerable by `grep` and by the bundler, without
 * opening a file or following an import.
 */
export const ISLAND_EXTENSION = '.island.tsx';

/** Registered globally so two copies of this module agree on what an island node is. */
export const ISLAND_NODE: unique symbol = Symbol.for('ultimate.render.island') as never;

/** Characters that would break out of the `data-x-entry` attribute the specifier lands in. */
const UNSAFE_SPECIFIER = /["'`<>\s\\]/;

/** The same test the resolver's output has to pass: one rule, applied at both ends of the seam. */
export function isEmittableSpecifier(value: string): boolean {
  return value.length > 0 && !UNSAFE_SPECIFIER.test(value);
}

export interface IslandDeclaration<TKeys extends readonly string[] = readonly string[]> {
  /** Relative specifier of the client entry, e.g. `./contact-modal.island.tsx`. */
  readonly src: string;
  /** The exact prop names this island accepts. Anything else is a build failure. */
  readonly props?: TKeys;
  /** The wrapper element. `span` for an island inside a line of text. */
  readonly tag?: string;
  /** Events replayed for `hydrate: 'interaction'`. */
  readonly events?: readonly string[];
  /** `rootMargin` for `hydrate: 'visible'`. */
  readonly rootMargin?: string;
}

/** The normalized declaration. `island()` is the one normalizer, as `defineRoute` is for routes. */
export interface IslandSpec {
  /** Stable, derived from `src`: the unit a bundle is measured in and a budget counts. */
  readonly moduleId: string;
  readonly src: string;
  readonly propKeys: readonly string[];
  readonly tag: string;
  readonly events?: readonly string[];
  readonly rootMargin?: string;
}

/**
 * An island node is a branded ARRAY, and that is not decoration.
 *
 * An app types its JSX with `jsxImportSource: solid-js`, whose `JSX.Element` is a type ALIAS —
 * `Node | ArrayElement | (string & {}) | number | boolean | null | undefined` — so it can neither
 * be augmented nor satisfied by a plain object. A component returning one is TS2786 at every
 * `<ContactSales />`, which is how a feature whose whole point is "a contact modal on an otherwise
 * static page" shipped usable only through `h(Modal, …)`. `ArrayElement` is the union's one
 * object-shaped member, so being an array is what makes the island an ordinary JSX child.
 *
 * The array is empty and stays empty — the shell is `props.children`, walked by `render-html.ts`,
 * and `never[]` is the honest element type for an array nothing is ever pushed into. It also keeps
 * render free of `solid-js`: the constraint is satisfied structurally, not by importing the union.
 * `type-pins.tsx` is what holds the claim to a build error.
 */
export interface IslandNode extends Array<never> {
  readonly [ISLAND_NODE]: true;
  readonly spec: IslandSpec;
  readonly props: JsxProps;
}

/**
 * Tested BEFORE `Array.isArray` by every walker, since an island node is now both. `render-html.ts`
 * is the one that matters: the array branch would render an empty shell and drop the island.
 */
export function isIslandNode(value: unknown): value is IslandNode {
  return typeof value === 'object' && value !== null && ISLAND_NODE in value;
}

/** Declared props are JSON, plus the server-only children that become the island's shell. */
export type IslandComponent<TKeys extends readonly string[]> = (
  props: Readonly<Record<TKeys[number], JsonValue>> & { readonly children?: unknown },
) => IslandNode;

/**
 * `./contact-modal.island.tsx` → `contact-modal`; `../shared/search.island.tsx` → `shared-search`.
 * Derived from the path rather than hashed so the id in the HTML, the budget report and the
 * manifest is the one an author can find on disk.
 */
export function islandModuleId(src: string): string {
  return src
    .slice(0, -ISLAND_EXTENSION.length)
    .replace(/^(?:\.\.?\/)+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Islands declared since the last `defineRoute` drained this list — the seam that lets a page
 * declaring an island hydrate without saying so twice.
 *
 * Ambient, and deliberately not the thing `island-collector.ts` refuses to be: that one is about
 * a RENDER, where two concurrent requests would bill one page for the other's JS. This one is
 * about a MODULE, evaluated once, on one thread, before any request exists — and `src` is resolved
 * relative to the route file (`island-bundle.ts`), so an `island()` call is a route-module-local
 * declaration by construction. `defineRoute` empties it, so nothing accumulates.
 */
const declaredIslands: IslandSpec[] = [];

/**
 * Called by `defineRoute` alone. Returns what this module declared and resets the list.
 *
 * Package-internal on purpose — reachable from `./island`, absent from `src/index.ts`. An app that
 * could call this between its `island()` and its `defineRoute` would silently drain the
 * declarations the route derives `hydrate`, `budget.js` and `entry.islands` from, and get a page
 * that renders an island nothing boots. Machinery is not API, and a public export is semver-locked
 * the moment it ships.
 */
export function drainDeclaredIslands(): readonly IslandSpec[] {
  if (declaredIslands.length === 0) return [];
  const drained = [...declaredIslands];
  declaredIslands.length = 0;
  return drained;
}

/**
 * Whether this exact spec is still waiting to be drained — which is decidable, and is the whole
 * difference between the two causes of `X_ISLAND_NOT_HYDRATED`. A spec still pending at RENDER
 * time was declared where no `defineRoute` could see it (below the route, or outside a route
 * module); a spec already drained means the route reached `'never'` because an author wrote it.
 *
 * Identity, not equality: `island()` pushes the object it closes over, so the spec reaching the
 * collector is the same one, and two islands with identical fields never collide.
 */
export function islandNeverDrained(spec: IslandSpec): boolean {
  return declaredIslands.includes(spec);
}

/** Test seam: the list is process-global because the module cache it mirrors is too. */
export function clearDeclaredIslands(): void {
  declaredIslands.length = 0;
}

/**
 * Declare an island. Runs at the page module's scope, so a bad declaration fails when the route
 * is loaded — at build time for `static`, and before the first request for every other mode.
 *
 * Declare it ABOVE `defineRoute`, which is where JavaScript already puts a `const` a page uses:
 * that is what lets the route derive `hydrate` and its JS budget instead of asking for both. An
 * island declared below the route still renders — and still fails loudly, as
 * `X_ISLAND_NOT_HYDRATED`, rather than shipping markup nothing boots.
 */
export function island<const TKeys extends readonly string[] = []>(
  declaration: IslandDeclaration<TKeys>,
): IslandComponent<TKeys> {
  const spec = normalizeIsland(declaration);
  declaredIslands.push(spec);
  return (props) => islandNode(spec, props as JsxProps);
}

/** The one constructor. `Object.assign` over an array is what gives the node both identities. */
function islandNode(spec: IslandSpec, props: JsxProps): IslandNode {
  return Object.assign([] as never[], { [ISLAND_NODE]: true as const, spec, props });
}

function normalizeIsland(declaration: IslandDeclaration): IslandSpec {
  const src = declaration.src;
  if (typeof src !== 'string' || src.length === 0) {
    throw new IslandInvalidError(
      'island() was given no src, so there is no module for the browser to import',
      `pass src: './<name>${ISLAND_EXTENSION}' — the client entry, as a specifier, never an import`,
    );
  }
  if (src.includes('://')) {
    throw new IslandInvalidError(
      `island src ${JSON.stringify(src)} is a remote URL, so it is outside the bundle graph and ` +
        'outside the route budget that has to count it',
      `vendor the module into the app and pass src: './<name>${ISLAND_EXTENSION}'`,
    );
  }
  if (UNSAFE_SPECIFIER.test(src)) {
    throw new IslandInvalidError(
      `island src ${JSON.stringify(src)} contains a character that cannot appear in the ` +
        'data-x-entry attribute it is emitted into',
      `rename the module to a plain path and pass src: './<name>${ISLAND_EXTENSION}'`,
    );
  }
  if (!src.endsWith(ISLAND_EXTENSION)) {
    const stem = src.replace(/\.[jt]sx?$/, '');
    throw new IslandInvalidError(
      `island src ${JSON.stringify(src)} is not an island file: a module ships to the browser ` +
        `only if its name says so, and ${ISLAND_EXTENSION} is the one spelling that says it`,
      `git mv -- ${src} ${stem}${ISLAND_EXTENSION}, then pass src: '${stem}${ISLAND_EXTENSION}'`,
    );
  }

  const moduleId = islandModuleId(src);
  if (moduleId.length === 0) {
    throw new IslandInvalidError(
      `island src ${JSON.stringify(src)} has no name left once ${ISLAND_EXTENSION} is removed`,
      `name the module: src: './<name>${ISLAND_EXTENSION}'`,
    );
  }

  return {
    moduleId,
    src,
    propKeys: declaration.props ?? [],
    tag: declaration.tag ?? 'div',
    ...(declaration.events === undefined ? {} : { events: declaration.events }),
    ...(declaration.rootMargin === undefined ? {} : { rootMargin: declaration.rootMargin }),
  };
}
