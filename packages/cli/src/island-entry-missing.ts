// The refusals for an island the build cannot answer: a `buildIslands({ only })` naming no island, and
// a route's `src` resolving to a file the build did not bundle. Split from `island-bundle.ts`, which
// keeps the build; both refusals are render's `X_ISLAND_INVALID` (see `entryMissing`).

// why: Bun ships no path API; `posix` does the specifier arithmetic on app-relative paths.
import { posix } from 'node:path';
import { ISLAND_EXTENSION, IslandInvalidError } from '@ultimat3/render';
import { quoteArg } from './shell-quote';

/**
 * Same code as an unbuildable `src`: "this path cannot become a client entry" is one condition.
 *
 * Two fixes, because there are two causes and only one of them can be repaired by naming a path.
 * The line was `pass only: '<app-root-relative path>.island.tsx'` — a placeholder nobody can run,
 * which no gate could see: `fixProblem` fails a fix only for ADVICE with no command token, and a
 * sentence with neither is not advice. Both forms below are constructed from what the caller
 * already handed in, so neither can name a path this app does not have.
 */
export function onlyMissing(only: string, discovered: readonly string[]): IslandInvalidError {
  const cause =
    `buildIslands was asked for ${JSON.stringify(only)} alone, which is not one of the ` +
    `${discovered.length} islands this app has (${discovered.length === 0 ? 'none' : discovered.join(', ')})`;
  // The basename match first: a filter that misses normally missed on the PREFIX — a route-relative
  // specifier where `discoverIslands`' app-root-relative path was wanted — and the filename
  // survives that. Falling back to the first keeps the fix a real path rather than a shape.
  const nearest =
    discovered.find((file) => posix.basename(file) === posix.basename(only)) ?? discovered[0];
  // An app with no islands cannot be pointed at one, so the fix WRITES the file that was asked
  // for — the same command `entryMissing` hands back, split off the same path.
  if (nearest === undefined) {
    return new IslandInvalidError(cause, generateIslandFix(only));
  }
  return new IslandInvalidError(cause, `buildIslands(root, { only: '${nearest}' })`);
}

/**
 * The specifier named no file the build could bundle. `X_ISLAND_INVALID` is render's and is
 * borrowed rather than renamed here: "this src cannot become a client entry" is the condition that
 * code already means, and a second name for it is a second thing to look up.
 */
export function entryMissing(
  routeFile: string,
  src: string,
  target: string,
  chunks: readonly { readonly file: string }[],
): IslandInvalidError {
  const known = chunks.map((chunk) => chunk.file);
  return new IslandInvalidError(
    `${routeFile} declares island src ${JSON.stringify(src)}, which resolves to ${target} — a ` +
      `file this build did not bundle (${known.length === 0 ? 'it found no islands at all' : `it found ${known.join(', ')}`})`,
    generateIslandFix(target),
  );
}

/**
 * `x g island <name> --at <dir>`, split off a path the caller or a route file supplied. Each half is
 * quoted (security audit of plan 101 sweep 1c, M1), and one opening with `-` is the placeholder:
 * quoting does not stop `x` reading `--json` as a flag (L3).
 */
function generateIslandFix(path: string): string {
  const name = posix.basename(path, ISLAND_EXTENSION);
  const dir = posix.dirname(path);
  return `x g island ${quoteArg(name.startsWith('-') ? '<name>' : name)} --at ${quoteArg(dir.startsWith('-') ? '<dir>' : dir)}`;
}
