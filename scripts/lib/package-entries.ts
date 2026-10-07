// Every `@ultimat3/*` public entry and the VALUES it exports, read from the entry module each
// `package.json` `exports` key names — never a hand list, so a new export is covered the day it
// ships — and, per value, the package that DECLARES it rather than re-exports it.

// why: Bun exposes no path-join primitive; module keys are root-relative POSIX on every OS.
import { posix } from 'node:path';
import { type Reexport, reexportsIn } from './reexport-scan';
import { repoRoot } from './run';

const SCOPE = '@ultimat3/';

export interface PackageEntry {
  /** The package's directory under `packages/`. */
  readonly dir: string;
  /** Its `package.json` `name`. */
  readonly pkg: string;
  /** The `exports` key, `.` or `./x` — a `*` key expanded, one entry per module it matches. */
  readonly subpath: string;
  /** What a caller writes: `@ultimat3/core`, `@ultimat3/core/page`. */
  readonly specifier: string;
  /** The entry module, repo-relative. */
  readonly file: string;
  readonly values: ReadonlySet<string>;
}

const ROOT = repoRoot();
const at = (path: string): string => `${ROOT}/${path}`;

/**
 * `Bun.Transpiler.scan` drops type-only exports exactly as the emitted module does, so its list is
 * the runtime namespace — held equal to `Object.keys(await import(…))` for core by the test.
 * Static, because importing every entry would run `preload`, `sync-worker` and `serve` for real.
 */
const valuesOf = async (file: string): Promise<ReadonlySet<string>> =>
  new Set(
    new Bun.Transpiler({ loader: file.endsWith('.tsx') ? 'tsx' : 'ts' }).scan(
      await Bun.file(at(file)).text(),
    ).exports,
  );

const isModule = (file: string): boolean => /\.tsx?$/.test(file);

async function entriesOf(manifest: string): Promise<readonly PackageEntry[]> {
  const dir = manifest.slice('packages/'.length, -'/package.json'.length);
  const parsed: unknown = await Bun.file(at(manifest)).json();
  const { name, exports } = parsed as {
    readonly name: string;
    readonly exports?: Readonly<Record<string, unknown>>;
  };
  const found: PackageEntry[] = [];
  for (const [subpath, target] of Object.entries(exports ?? {})) {
    if (typeof target !== 'string' || !isModule(target.replace('*', '.ts'))) continue;
    const base = `packages/${dir}/${target.slice(2)}`;
    const files = target.includes('*') ? [...new Bun.Glob(base).scanSync(ROOT)].sort() : [base];
    for (const file of files.filter(isModule)) {
      const [head = '', tail = ''] = base.split('*');
      const stem = file.slice(head.length, file.length - tail.length);
      const sub = subpath.replace('*', stem);
      const specifier = sub === '.' ? name : `${name}/${sub.slice(2)}`;
      found.push({ dir, pkg: name, subpath: sub, specifier, file, values: await valuesOf(file) });
    }
  }
  return found;
}

const MANIFESTS = [...new Bun.Glob('packages/*/package.json').scanSync(ROOT)].sort();
const ALL = (await Promise.all(MANIFESTS.map(entriesOf))).flat();

/** Every `@ultimat3/*` entry — the values a re-export of another package is measured against. */
export const PACKAGE_ENTRIES: readonly PackageEntry[] = ALL.filter((e) => e.pkg.startsWith(SCOPE));

const BY_SPECIFIER: ReadonlyMap<string, PackageEntry> = new Map(
  PACKAGE_ENTRIES.map((entry) => [entry.specifier, entry]),
);

/** The package a repo path belongs to — `create-ultimate` included, so its files are scanned. */
const PKG_OF_DIR: ReadonlyMap<string, string> = new Map(ALL.map((e) => [e.dir, e.pkg]));
export const packageOfPath = (path: string): string | undefined =>
  PKG_OF_DIR.get(/^packages\/([^/]+)\//.exec(path)?.[1] ?? '');

/** The entry a specifier names, when it is an `@ultimat3/*` public entry. */
export const entryFor = (specifier: string): PackageEntry | undefined =>
  BY_SPECIFIER.get(specifier);

/** Whether `name` is a value `from` exports (`*`: `from` is an entry at all). */
export const isPackageValue = (from: string, name: string): boolean => {
  const entry = BY_SPECIFIER.get(from);
  return entry !== undefined && (name === '*' || entry.values.has(name));
};

const RELATIVE_EXPORT = /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*['"](\.[^'"]+)['"]/g;

async function resolveModule(from: string, spec: string): Promise<string | undefined> {
  // A root-relative POSIX key, never a disk path: the join is posix on every OS.
  const base = posix.join(posix.dirname(from), spec);
  for (const file of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (isModule(file) && (await Bun.file(at(file)).exists())) return file;
  }
  return undefined;
}

/**
 * The entry's values that are another package's, by published alias: every module the entry
 * re-exports through, walked, and each one's re-exports of an `@ultimat3/*` value read. A rename
 * on the way up (`export { a as b } from './x'`) is not followed — this only aims a fix line.
 */
async function foreignOf(entry: PackageEntry): Promise<ReadonlyMap<string, Reexport>> {
  const foreign = new Map<string, Reexport>();
  const seen = new Set<string>();
  const queue = [entry.file];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await Bun.file(at(file)).text();
    for (const hit of reexportsIn(text, isPackageValue)) {
      if (entryFor(hit.from)?.pkg !== entry.pkg) foreign.set(hit.alias, hit);
    }
    for (const match of text.matchAll(RELATIVE_EXPORT)) {
      const next = await resolveModule(file, match[1] ?? '');
      if (next !== undefined) queue.push(next);
    }
  }
  return foreign;
}

const FOREIGN: ReadonlyMap<string, ReadonlyMap<string, Reexport>> = new Map(
  await Promise.all(
    PACKAGE_ENTRIES.map(async (entry) => [entry.specifier, await foreignOf(entry)] as const),
  ),
);

/**
 * Where `name`, imported from `from`, should be imported from: the package that DECLARES it,
 * through its NARROWEST entry carrying it — `@ultimat3/core/page` over `@ultimat3/core`, so a
 * fix line never sends a browser-safe value through the server graph.
 */
export interface ValueHome {
  readonly specifier: string;
  /** The value's name there — the declaring package's, when a re-export renamed it. */
  readonly name: string;
}

export function homeOf(from: string, name: string): ValueHome {
  let spec = from;
  let value = name;
  for (let hop = 0; hop < PACKAGE_ENTRIES.length; hop += 1) {
    const next = FOREIGN.get(spec)?.get(value);
    if (next === undefined) break;
    spec = next.from;
    value = next.name;
  }
  const pkg = entryFor(spec)?.pkg;
  const carriers = PACKAGE_ENTRIES.filter((e) => e.pkg === pkg && e.values.has(value));
  const narrowest = carriers.sort((a, b) => a.values.size - b.values.size)[0];
  return { specifier: narrowest?.specifier ?? spec, name: value };
}
