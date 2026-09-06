// What git ignores, as data. The one reader of a `.gitignore` in this package: `dev-watch.ts` asks
// it which directories `x dev` must not watch, and `fix-path.ts` asks it which citations name a
// file this repository never commits. A second reader would be a second answer, and the two would
// disagree on the first pattern neither author anticipated.

// why: Bun exposes no synchronous file read and no synchronous existence primitive —
// `Bun.file(p).text()` is async, and the ignore set is rebuilt inside an `fs.watch` callback where
// an await opens a window for the next event. Delete when Bun ships sync equivalents.
import { existsSync, readFileSync } from 'node:fs';
// why: Bun exposes no path-join, dirname or relative primitive. The same necessity `fix-path.ts`
// already records for `join`.
import { dirname, join, relative, sep } from 'node:path';

/** One line of a `.gitignore`, read for what it states rather than for what a reader assumes. */
export interface IgnorePattern {
  /** The glob, without its leading `/` or trailing `/`. */
  readonly glob: string;
  /** Held against the whole path relative to the file's own directory, never the basename. */
  readonly anchored: boolean;
  /** A trailing `/`: it matches a directory and never a file of that name. */
  readonly directoryOnly: boolean;
  /** A leading `!`: it re-includes what an earlier pattern ignored, at the same level. */
  readonly negated: boolean;
}

/** One `.gitignore` file and the directory every one of its patterns is relative to. */
export interface IgnoreScope {
  readonly base: string;
  readonly patterns: readonly IgnorePattern[];
}

/**
 * A pattern is ANCHORED when it holds a `/` anywhere but at its end — git's own rule, and the one
 * a hand-rolled reader gets wrong in both directions: `coverage/` ignores a `coverage` directory at
 * any depth, while `/coverage/` and a pattern holding an inner slash only ever match where they
 * are written.
 */
export function parseGitignore(text: string): readonly IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (const raw of text.split('\n')) {
    // Trailing whitespace carries no rule unless escaped; a leading `#` is a comment, and `\#` is
    // a filename that starts with one.
    const line = raw.replace(/\\?\s+$/, (match) => (match.startsWith('\\') ? match : ''));
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const body = (negated ? line.slice(1) : line).replace(/^\\(?=[#!])/, '');
    if (body === '' || body === '/') continue;
    const directoryOnly = body.endsWith('/');
    const trimmed = directoryOnly ? body.slice(0, -1) : body;
    const rooted = trimmed.startsWith('/');
    const glob = rooted ? trimmed.slice(1) : trimmed;
    if (glob === '') continue;
    patterns.push({ glob, anchored: rooted || glob.includes('/'), directoryOnly, negated });
  }
  return patterns;
}

/** The patterns one directory's own `.gitignore` states, or none where it has no such file. */
export function readIgnoreFile(directory: string): readonly IgnorePattern[] {
  const file = join(directory, '.gitignore');
  return existsSync(file) ? parseGitignore(readFileSync(file, 'utf8')) : [];
}

/**
 * The `.gitignore` files that govern `root`: its own last, then every ancestor up to and including
 * the directory holding `.git`. Outermost first, so a nearer file's pattern is read last and wins —
 * `examples/dummy` carries no ignore file of its own and every rule about it lives in the
 * repository root's, which is why reading one file made `touch tsconfig.tsbuildinfo` a full reload.
 */
export function ignoreScopes(root: string): readonly IgnoreScope[] {
  const scopes: IgnoreScope[] = [];
  let directory = root;
  for (;;) {
    const patterns = readIgnoreFile(directory);
    if (patterns.length > 0) scopes.unshift({ base: directory, patterns });
    if (existsSync(join(directory, '.git'))) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return scopes;
}

/** Compiled once per pattern: one `x dev` walk asks the same glob of every directory it meets. */
const globs = new Map<string, Bun.Glob>();

function globFor(pattern: string): Bun.Glob {
  const known = globs.get(pattern);
  if (known !== undefined) return known;
  const glob = new Bun.Glob(pattern);
  globs.set(pattern, glob);
  return glob;
}

/** The path relative to `base`, POSIX-separated, or `undefined` when it is not under it. */
function relativeUnder(base: string, path: string): string | undefined {
  const rel = relative(base, path).split(sep).join('/');
  return rel === '' || rel.startsWith('../') || rel === '..' ? undefined : rel;
}

function matches(pattern: IgnorePattern, path: string, isDirectory: boolean): boolean {
  if (pattern.directoryOnly && !isDirectory) return false;
  const subject = pattern.anchored ? path : (path.split('/').at(-1) ?? path);
  return globFor(pattern.glob).match(subject);
}

/** Last match wins, across every scope in order — git's rule, and the reason `!` works at all. */
function verdictFor(
  scopes: readonly IgnoreScope[],
  path: string,
  isDirectory: boolean,
): boolean | undefined {
  let verdict: boolean | undefined;
  for (const scope of scopes) {
    const rel = relativeUnder(scope.base, path);
    if (rel === undefined) continue;
    for (const pattern of scope.patterns) {
      if (matches(pattern, rel, isDirectory)) verdict = !pattern.negated;
    }
  }
  return verdict;
}

/**
 * Whether git would ignore this absolute path. Every ancestor between the outermost scope and the
 * path is judged as a DIRECTORY first: an ignored directory takes everything under it, which is how
 * `coverage/` reaches `coverage/lcov.info` and the only reason a walk may prune at all.
 */
export function isGitIgnored(
  scopes: readonly IgnoreScope[],
  path: string,
  isDirectory: boolean,
): boolean {
  const outermost = scopes[0];
  if (outermost === undefined) return false;
  const rel = relativeUnder(outermost.base, path);
  if (rel === undefined) return false;
  const segments = rel.split('/');
  for (let depth = 0; depth < segments.length; depth += 1) {
    const prefix = join(outermost.base, ...segments.slice(0, depth + 1));
    const last = depth === segments.length - 1;
    if (verdictFor(scopes, prefix, last ? isDirectory : true) === true) return true;
  }
  return false;
}
