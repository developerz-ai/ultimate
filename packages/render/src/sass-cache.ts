// A content-addressed disk cache for one Sass compilation: keyed by the compiler, the file and its
// source, and valid only while every file that compilation READ still hashes the same. Sass has no
// cache across compilations, so every `.module.scss` re-parses `@ultimat3/ui/tokens` — measured on
// notificado.co (140 modules), 3.7 s wall and 12 s CPU of `x manifest --check`'s 6.5 s wall.

// why: `compileStylesheet` is synchronous — Bun's loader `onLoad` path calls it inline — and Bun
// ships no synchronous file read, write or rename; `node:fs` is the only sync file API.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';

/** Relative to the process's cwd — the app root for every `x` command. `.x/` is gitignored. */
export const SASS_CACHE_DIR = join('.x', 'cache', 'sass');

/** Bumped when the entry shape changes, so an old entry is a miss and never a misread. */
const ENTRY_VERSION = 1;

/** `undefined`: the default dir under cwd. `null`: off. A string: that directory. */
let configured: string | null | undefined;

/** Test/host seam. `null` turns the cache off; `undefined` restores the default. */
export function setSassCacheDir(dir: string | null | undefined): void {
  configured = dir;
}

const cacheDir = (): string | null =>
  configured === undefined ? join(process.cwd(), SASS_CACHE_DIR) : configured;

const sha256 = (input: string | Uint8Array): string =>
  new Bun.CryptoHasher('sha256').update(input).digest('hex');

/**
 * What one compilation produced, and every file it read to produce it — as PATHS, `undefined` for
 * a load that was not a file. The caller converts Sass's URLs: `node:url` stays in `css-modules.ts`,
 * the one file the browser-barrel test names as the build-time half.
 */
export interface SassOutput {
  readonly css: string;
  readonly loaded: readonly (string | undefined)[];
}

interface Entry {
  readonly v: number;
  readonly css: string;
  /** `[absolute path, sha256 of its bytes]` for every file the compilation read. */
  readonly loaded: readonly (readonly [string, string])[];
}

/**
 * Every module `@use`s the same token files, so one run hashes each of them once rather than once
 * per module. Keyed by size and mtime as well as path: under `x dev` a token file is edited while
 * the process lives, and a path-only memo would validate every entry against the old bytes.
 */
const digests = new Map<string, string>();

const digestOf = (path: string): string | undefined => {
  try {
    const stat = statSync(path);
    const memo = `${path}\0${String(stat.size)}\0${String(stat.mtimeMs)}`;
    const known = digests.get(memo);
    if (known !== undefined) return known;
    const digest = sha256(readFileSync(path));
    digests.set(memo, digest);
    return digest;
  } catch {
    return undefined;
  }
};

const isEntry = (value: unknown): value is Entry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry['v'] === ENTRY_VERSION &&
    typeof entry['css'] === 'string' &&
    Array.isArray(entry['loaded']) &&
    entry['loaded'].every(
      (pair: unknown) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string',
    )
  );
};

/** A hit only when every file the stored compilation read is byte-identical today. */
const readHit = (file: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isEntry(parsed)) return undefined;
  return parsed.loaded.every(([path, digest]) => digestOf(path) === digest)
    ? parsed.css
    : undefined;
};

/**
 * Best effort: a read-only filesystem (a production container) or a race with another worker
 * costs the next run a compile, never this one its result. Written beside and renamed, so a
 * concurrent reader sees a whole entry or none.
 */
const store = (dir: string, file: string, output: SassOutput): void => {
  // A compilation that read something other than a file cannot be validated by re-reading it.
  const loaded: (readonly [string, string | undefined])[] = [];
  for (const path of output.loaded) {
    if (path === undefined) return;
    loaded.push([path, digestOf(path)]);
  }
  if (loaded.some(([, digest]) => digest === undefined)) return;
  const entry = { v: ENTRY_VERSION, css: output.css, loaded };
  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.${Bun.nanoseconds()}.tmp`;
    writeFileSync(temporary, JSON.stringify(entry));
    renameSync(temporary, file);
  } catch {
    // Nothing to report: the css this call returns is already correct.
  }
};

/**
 * The css `compile` would return for `key`, read from disk when a previous compilation of the
 * same key read the same bytes. `key` must name everything that is not a loaded file: the
 * compiler version, the options, the file's path and its source.
 */
export function cachedSassCompile(key: string, compile: () => SassOutput): string {
  const dir = cacheDir();
  if (dir === null) return compile().css;
  const file = join(dir, `${sha256(key)}.json`);
  const hit = readHit(file);
  if (hit !== undefined) return hit;
  const output = compile();
  store(dir, file, output);
  return output.css;
}
