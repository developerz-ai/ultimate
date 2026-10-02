// The browser-transport rule (`browser-transport.ts`) over ONE APP: what `x verify`'s `boundaries`
// step reports for a raw `fetch(` in an island. Built in rather than a file in `guards/` — a rule
// an app can delete is a rule the next agent deletes.
//
// It reads nothing `readAppSources` already read. The islands and the surface files arrive in
// memory; the only new I/O is the app's `tsconfig.json`, its workspace manifests, the installed
// `@ultimat3/*` manifests (which name the browser entries), and — lazily — the files of the app's
// own `packages/*` an island actually imports. An app with no island pays for none of it.
//
// The walk STOPS at an installed package: `@ultimat3/core`'s `clientTransport`, realtime's socket
// and storage's upload client are the three seams, they live in `node_modules`, and they are
// trusted rather than re-read — in an app, no file may open its own connection.

// why: `ClosureHost.read` is synchronous (the walk is a plain loop) and `Bun.file().text()` is not.
import { readFileSync } from 'node:fs';
// why: Bun ships no path API; this reaches a file on disk with the host's separator.
import { join } from 'node:path';
import { isJsonObject } from '@ultimat3/core';
import type { SourceFile } from './app-boundaries';
import type { FindingContext } from './browser-transport';
import {
  barrelFinding,
  browserEntries,
  bypassFinding,
  checkBrowserTransport,
} from './browser-transport';
import type { ClosureHost } from './import-closure';
import type { Finding } from './output';
import { hasPathSegment } from './path-segments';
import { serverBarrels } from './server-barrels';
import type { TransportShape } from './transport-calls';

/** What an app is told may hold each shape: the framework's function, never a file of its own. */
const HOLDER: ReadonlyMap<TransportShape, string> = new Map([
  ['fetch', "@ultimat3/core's clientTransport"],
  ['websocket', "@ultimat3/realtime's page socket"],
  ['xhr', "@ultimat3/storage's uploadFile"],
]);

const CONTEXT: FindingContext = {
  holder: (shape) => HOLDER.get(shape),
  rerun: 'x verify --only boundaries --json',
};

/** One `paths` row or one `exports` row, as a specifier pattern: at most one `*` on each side. */
interface Pattern {
  readonly head: string;
  readonly tail: string;
  readonly wild: boolean;
  /** Root-relative, `*` still in place. */
  readonly target: string;
}

const patternOf = (key: string, target: string): Pattern => {
  const star = key.indexOf('*');
  return star < 0
    ? { head: key, tail: '', wild: false, target }
    : { head: key.slice(0, star), tail: key.slice(star + 1), wild: true, target };
};

/** The path `spec` names under `pattern`, or `undefined` when the pattern is not about it. */
function applied(pattern: Pattern, spec: string): string | undefined {
  if (!pattern.wild) return spec === pattern.head ? pattern.target : undefined;
  if (!spec.startsWith(pattern.head) || !spec.endsWith(pattern.tail)) return undefined;
  if (spec.length < pattern.head.length + pattern.tail.length) return undefined;
  const middle = spec.slice(pattern.head.length, spec.length - pattern.tail.length);
  return pattern.target.replace('*', middle);
}

const posix = (path: string): string => path.split('\\').join('/').replace(/^\.\//, '');

/** A manifest or a tsconfig, or `undefined`: absent and unreadable both mean "says nothing". */
async function readObject(path: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    // JSONC: a tsconfig may carry comments and trailing commas, and a strict parse would turn one
    // into "this app has no aliases" — every island's imports unresolved, the rule silently blind.
    const parsed: unknown = Bun.JSONC.parse(await file.text());
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `compilerOptions.paths` of the app's root tsconfig — how its own packages are spelled. */
async function tsconfigPatterns(root: string): Promise<readonly Pattern[]> {
  const options = (await readObject(join(root, 'tsconfig.json')))?.['compilerOptions'];
  const paths = isJsonObject(options) ? options['paths'] : undefined;
  if (!isJsonObject(paths)) return [];
  return Object.entries(paths).flatMap(([key, targets]) => {
    const first: unknown = Array.isArray(targets) ? targets[0] : undefined;
    return typeof first === 'string' ? [patternOf(key, posix(first))] : [];
  });
}

interface Workspaces {
  /** Every specifier a workspace package publishes, as a pattern onto its file. */
  readonly patterns: readonly Pattern[];
  /** Package name → its directory, for "is this file inside the package that barrel names". */
  readonly dirs: ReadonlyMap<string, string>;
}

/** The app's own `apps/*` and `packages/*`, by the `name` and `exports` each manifest declares. */
async function workspaces(root: string): Promise<Workspaces> {
  const patterns: Pattern[] = [];
  const dirs = new Map<string, string>();
  for await (const manifest of new Bun.Glob('{apps,packages}/*/package.json').scan({ cwd: root })) {
    const dir = posix(manifest).split('/').slice(0, 2).join('/');
    const parsed = await readObject(join(root, manifest));
    const name = parsed?.['name'];
    if (typeof name !== 'string') continue;
    dirs.set(name, dir);
    const exports = isJsonObject(parsed?.['exports']) ? parsed['exports'] : {};
    for (const [sub, target] of Object.entries(exports)) {
      if (typeof target !== 'string') continue;
      const spec = sub === '.' ? name : `${name}${sub.slice(1)}`;
      patterns.push(patternOf(spec, `${dir}/${posix(target)}`));
    }
  }
  return { patterns, dirs };
}

const INSTALLED = [
  'node_modules/@ultimat3/*/package.json',
  // A workspace install may leave a package beside the workspace that asked for it.
  '{apps,packages}/*/node_modules/@ultimat3/*/package.json',
];

/** Every specifier the installed framework publishes — what `serverBarrels` derives its map from. */
async function installedSpecifiers(root: string): Promise<ReadonlySet<string>> {
  const specifiers = new Set<string>();
  for (const pattern of INSTALLED) {
    const found = new Bun.Glob(pattern).scan({ cwd: root, followSymlinks: true });
    for await (const manifest of found) {
      const parsed = await readObject(join(root, manifest));
      const name = parsed?.['name'];
      if (typeof name !== 'string') continue;
      const exports = isJsonObject(parsed?.['exports']) ? parsed['exports'] : {};
      for (const sub of Object.keys(exports)) {
        if (!sub.includes('*')) specifiers.add(sub === '.' ? name : `${name}${sub.slice(1)}`);
      }
    }
  }
  return specifiers;
}

const SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * The closure's view of the app: the surface files from memory, a file of the app's own
 * `packages/*` from disk the first time an island reaches it, and nothing under `node_modules` —
 * a relative import that climbs into an installed package is still past the boundary.
 */
function hostOf(
  root: string,
  sources: ReadonlyMap<string, string>,
  patterns: readonly Pattern[],
): ClosureHost {
  const disk = new Map<string, string | undefined>();
  const read = (path: string): string | undefined => {
    const held = sources.get(path);
    if (held !== undefined) return held;
    if (!/\.tsx?$/.test(path) || hasPathSegment(path, 'node_modules')) return undefined;
    if (!disk.has(path)) {
      try {
        disk.set(path, readFileSync(join(root, path), 'utf8'));
      } catch {
        disk.set(path, undefined);
      }
    }
    return disk.get(path);
  };
  const alias = (spec: string): string | undefined => {
    for (const pattern of patterns) {
      const base = applied(pattern, spec);
      if (base === undefined) continue;
      for (const suffix of SUFFIXES) {
        if (read(`${base}${suffix}`) !== undefined) return `${base}${suffix}`;
      }
    }
    return undefined;
  };
  return { read, alias };
}

/**
 * `X_BROWSER_TRANSPORT_BYPASS` and `X_BROWSER_SERVER_BARREL` for the app at `root`, over the
 * sources `readAppSources` already holds.
 */
export async function appTransportFindings(
  root: string,
  files: readonly SourceFile[],
): Promise<readonly Finding[]> {
  const sources = new Map(files.map((file) => [file.path, file.source]));
  const entries = browserEntries(sources);
  if (entries.length === 0) return [];
  const [paths, own, installed] = await Promise.all([
    tsconfigPatterns(root),
    workspaces(root),
    installedSpecifiers(root),
  ]);
  const published = [...installed, ...own.patterns.filter((p) => !p.wild).map((p) => p.head)];
  const { bypasses, barrels } = checkBrowserTransport({
    entries,
    // The tsconfig first: it is what the app's own typecheck resolves through.
    host: hostOf(root, sources, [...paths, ...own.patterns]),
    seams: new Map(),
    barrels: serverBarrels(published),
    ownsBarrel: (file, barrel) => {
      const dir = own.dirs.get(barrel);
      return dir !== undefined && file.startsWith(`${dir}/`);
    },
  });
  return [
    ...bypasses.map((bypass) => bypassFinding(bypass, CONTEXT)),
    ...barrels.map((barrel) => barrelFinding(barrel, CONTEXT)),
  ];
}
