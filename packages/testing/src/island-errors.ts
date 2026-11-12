// The two refusals `mountIsland` gives before any island code runs: the file the test named was
// not built, or its chunk exports no `mount`. Codes registered with the rest in `errors.ts`.

import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';

/** Neither path is controlled by the framework: both arrive from the test's own call. */
const ISLAND_PLACEHOLDER = '<the island path the cause names>';

/**
 * The builder produced no chunk for the file the test named. Listing what it DID build is the
 * whole value: a path relative to the test file instead of to the app root, a typo, and an island
 * outside the discovery glob are one symptom and three different edits, and only the list tells
 * them apart. An empty list is its own answer — the glob found nothing at all under this root.
 */
export class IslandNotBuiltError extends UltimateError {
  constructor(input: { file: string; root: string; built: readonly string[] }) {
    const file = renderFixLiteral(input.file, ISLAND_PLACEHOLDER);
    super({
      code: 'X_TEST_ISLAND_NOT_BUILT',
      cause:
        input.built.length === 0
          ? `no island was built under ${renderCauseValue(input.root)}, so ${renderCauseValue(input.file)} cannot be mounted`
          : `${renderCauseValue(input.file)} is not in the bundle built from ${renderCauseValue(input.root)}; it built ${input.built.join(', ')}`,
      fix:
        input.built.length === 0
          ? 'x g island <name> --at apps/web/site — then set root to the directory holding apps/'
          : `mountIsland({ build, root, file: ${renderFixLiteral(input.built[0], ISLAND_PLACEHOLDER)} }) — the path is app-root-relative, not relative to the test, and ${file} is not one of them`,
    });
  }
}

export const islandNotBuilt = (
  file: string,
  root: string,
  built: readonly string[],
): UltimateError => new IslandNotBuiltError({ file, root, built });

/** A name that can be written as a JSX tag. `export default` and `export { x as 'a b' }` are both
 *  legal ES and neither can — a paste emitting one is a syntax error in the reader's own file. */
const JSX_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * The export the paste renders. A component first — an initial capital that is not the whole name,
 * which is what separates `Counter` from a `PROPS` constant — and any other usable identifier
 * after it, because a lowercase component still compiles and beats a name the reader must invent.
 */
const componentOf = (exported: readonly string[]): string | undefined => {
  const usable = exported.filter((name) => JSX_NAME.test(name) && name !== 'default');
  return usable.find((name) => /^[A-Z]/.test(name) && name !== name.toUpperCase()) ?? usable[0];
};

/**
 * The chunk built and imported, and exports no `mount`. Distinct from a build failure: the island
 * compiles, ships and is served — the hydration runtime calls `m.mount(el, props)` and the browser
 * throws on a page that passed every gate. Naming the exports it DOES have is what separates a
 * renamed export from a file that exports only its component.
 *
 * The paste is built from THOSE exports rather than from a sketch. It read
 * `render(() => <Island {...props} />, el)` with `props: Props` until 2026-08-21, and none of
 * `Island`, `Props` or `render` exists in the file the reader was told to paste it into — three
 * compile errors handed out as the remedy for one. Two of them the error already knew the answer
 * to, from its own cause; the third is an import, so the import is in the line.
 */
export class IslandMountMissingError extends UltimateError {
  constructor(input: { file: string; exported: readonly string[] }) {
    const file = renderFixLiteral(input.file, ISLAND_PLACEHOLDER);
    const component = componentOf(input.exported);
    super({
      code: 'X_TEST_ISLAND_NO_MOUNT',
      cause: `the chunk built from ${renderCauseValue(input.file)} exports ${
        input.exported.length === 0 ? 'nothing' : input.exported.join(', ')
      } — the hydration runtime calls m.mount(el, props)`,
      fix:
        component === undefined
          ? `${file} exports nothing a mount could render — x g island <name> --at apps/web/site writes an island whose mount() is already there, and its shape is the one to copy`
          : `in ${file} add: import { mountOver } from '@ultimat3/render/client'; import { render } from 'solid-js/web'; export function mount(el: HTMLElement, props: Parameters<typeof ${component}>[0]): () => void { return mountOver(el, (root) => render(() => <${component} {...props} />, root)); }`,
    });
  }
}

export const islandMountMissing = (file: string, exported: readonly string[]): UltimateError =>
  new IslandMountMissingError({ file, exported });
