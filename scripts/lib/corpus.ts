// The tree, read once per process: named scopes, each globbed, read and masked at most once, and
// each refusing to answer below a floor. About twenty guards each globbed and masked for
// themselves, spelt the same glob seven ways and measured five different corpus sizes of one tree
// — and a guard whose glob matched nothing answered "no findings", which is exactly what a clean
// tree answers. A scope below its floor is `X_CORPUS_UNSCANNED`, thrown, never an empty list.
//
// Imports only a leaf of `@ultimat3/core` by path: `scripts/boundaries.ts` reaches this module and
// must keep running with no `node_modules` present.

import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';
import { repoRoot } from './run';
import { ScriptError } from './script-error';
import { isTestPath } from './source-scan';

export type CorpusScope = 'source' | 'packages' | 'shipped' | 'tests';

/** What each scope globs. `source` is what `collectSourceFiles` has always returned. */
export const CORPUS_PATTERNS: Readonly<Record<CorpusScope, readonly string[]>> = Object.freeze<
  Record<CorpusScope, readonly string[]>
>({
  source: ['packages/*/src/**/*.{ts,tsx}', 'packages/*/e2e/**/*.{ts,tsx}', 'scripts/**/*.{ts,tsx}'],
  packages: ['packages/*/src/**/*.{ts,tsx}'],
  shipped: ['packages/*/src/**/*.{ts,tsx}'],
  tests: ['packages/*/src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
});

/**
 * Measured 2026-09-23: `source` 4,928 files, `packages` 4,692, `shipped` 3,234, `tests` 1,557. A floor is a
 * fraction of that, low enough that deleting a package never trips it and high enough that an
 * unreadable `packages/` or a glob that stopped matching always does. It is THIS repository's
 * floor: any other root — a test fixture of three files — must still read at least one.
 */
export const CORPUS_FLOORS: Readonly<Record<CorpusScope, number>> = Object.freeze<
  Record<CorpusScope, number>
>({ source: 1000, packages: 1000, shipped: 1000, tests: 500 });

const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist)\//;

export interface CorpusFile {
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  /** The file as written. Named `source` so a `CorpusFile` IS a `boundaries.ts` `SourceFile`. */
  readonly source: string;
  /** String and comment contents blanked, every offset kept: what the process would evaluate. */
  readonly masked: string;
  /** Comments blanked, strings kept. */
  readonly stripped: string;
}

/** A file whose masks are computed on first read and kept: most guards read one of the two. */
function corpusFile(path: string, source: string): CorpusFile {
  let masked: string | undefined;
  let stripped: string | undefined;
  return {
    path,
    source,
    get masked() {
      masked ??= maskLiterals(source);
      return masked;
    },
    get stripped() {
      stripped ??= stripComments(source);
      return stripped;
    },
  };
}

/**
 * A glob that could not READ (`EACCES`, a half checkout) is refused outright — whatever the rest of
 * the scope found, part of it went unread, and "unread" must never be summed into "clean". One
 * answer for it, `X_CORPUS_UNSCANNED`, rather than a bare filesystem error some guards caught and
 * others did not.
 */
function globOrRefuse(root: string, scope: CorpusScope, pattern: string): readonly string[] {
  try {
    return [...new Bun.Glob(pattern).scanSync({ cwd: root })];
  } catch {
    throw new ScriptError({
      code: 'X_CORPUS_UNSCANNED',
      cause: `scope ${scope} could not read ${pattern} under ${root}, so a guard over it would report a clean tree it never read`,
      fix: 'bun install && bun run verify --only unit',
    });
  }
}

async function readScope(root: string, scope: CorpusScope): Promise<readonly CorpusFile[]> {
  const paths = new Set<string>();
  for (const pattern of CORPUS_PATTERNS[scope]) {
    for (const found of globOrRefuse(root, scope, pattern)) {
      const path = found.split('\\').join('/');
      if (NOT_SOURCE.test(path)) continue;
      if (scope === 'shipped' && isTestPath(path)) continue;
      paths.add(path);
    }
  }
  const sorted = [...paths].sort();
  const texts = await Promise.all(sorted.map((path) => Bun.file(`${root}/${path}`).text()));
  return sorted.map((path, index) => corpusFile(path, texts[index] ?? ''));
}

export const floorFor = (root: string, scope: CorpusScope): number =>
  root === repoRoot() ? CORPUS_FLOORS[scope] : 1;

/** The refusal a scope below its floor answers with, instead of an empty list. */
export const corpusUnscanned = (scope: CorpusScope, found: number, floor: number): ScriptError =>
  new ScriptError({
    code: 'X_CORPUS_UNSCANNED',
    cause: `scope ${scope} read ${found} files, floor ${floor} — a guard over it would report a clean tree it never read`,
    fix: 'bun install && bun run verify --only unit',
  });

const cache = new Map<CorpusScope, Promise<readonly CorpusFile[]>>();

async function readChecked(root: string, scope: CorpusScope): Promise<readonly CorpusFile[]> {
  const files = await readScope(root, scope);
  const floor = floorFor(root, scope);
  if (files.length < floor) throw corpusUnscanned(scope, files.length, floor);
  return files;
}

/**
 * One scope, read and checked against its floor; rejects with `X_CORPUS_UNSCANNED` below it.
 * THIS repository's scopes are read once per process and shared by every guard in it. Any other
 * root is read fresh on every call: a test fixture is written between two checks of one root.
 */
export function corpus(root: string, scope: CorpusScope): Promise<readonly CorpusFile[]> {
  if (root !== repoRoot()) return readChecked(root, scope);
  let hit = cache.get(scope);
  if (hit === undefined) {
    hit = readChecked(root, scope);
    // A refusal is not kept: the next caller re-reads, so a tree repaired mid-process is seen.
    hit.catch(() => cache.delete(scope));
    cache.set(scope, hit);
  }
  return hit;
}

/** The `shipped` scope in the `{ at, text }` shape the vocabulary rules read. */
export const shippedSources = async (
  root: string,
): Promise<readonly { readonly at: string; readonly text: string }[]> =>
  (await corpus(root, 'shipped')).map((file) => ({ at: file.path, text: file.source }));
