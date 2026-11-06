// The app's module graph as `@ultimat3/manifest`'s `ModuleFacts`: every source and test file, the
// app files each one imports — type-only imports included, since a type change breaks a test —
// a computed `import()` marking its file opaque, and which file declares which primitive.

// why: Bun ships no path API; a specifier resolves against its importing file's directory.
import { dirname, join, relative, resolve } from 'node:path';
import { describeActions, getAction } from '@ultimat3/action';
import { maskLiterals } from '@ultimat3/core';
import { registeredEntities } from '@ultimat3/entity';
import { registeredJobs, registeredTasks } from '@ultimat3/jobs';
import type { ModuleFacts } from '@ultimat3/manifest';
import { describeQueries, getQuery } from '@ultimat3/query';
import { routeEntries } from '@ultimat3/render';
import { scanAllImports } from './import-scan';
import { hasPathSegment } from './path-segments';
import { isTest } from './source-files';

/** Every authored TypeScript file an app holds: its apps, packages, guards, scripts and root. */
const FILE_GLOBS = [
  'apps/**/*.{ts,tsx}',
  'packages/**/*.{ts,tsx}',
  'guards/**/*.{ts,tsx}',
  'scripts/**/*.{ts,tsx}',
  '*.{ts,tsx}',
] as const;

/** A computed `import()` — any argument that does not open with a quote — read off masked code. */
const COMPUTED_IMPORT = /(?<![\w$.])import\s*\(\s*(?!['"])/;

const toPosix = (path: string): string => path.replace(/\\/g, '/');

const skipped = (path: string): boolean =>
  hasPathSegment(path, 'node_modules') ||
  hasPathSegment(path, 'dist') ||
  hasPathSegment(path, '.x') ||
  path.endsWith('.d.ts');

/** The app's files, root-relative POSIX, sorted. */
export async function appSourceFiles(root: string): Promise<readonly string[]> {
  const found = new Set<string>();
  for (const pattern of FILE_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      const posix = toPosix(path);
      if (!skipped(posix)) found.add(posix);
    }
  }
  return [...found].sort();
}

/** One file's app-internal imports (root-relative) and whether it computes one. */
export function fileImports(
  root: string,
  path: string,
  source: string,
): { readonly imports: readonly string[]; readonly opaque: boolean } {
  // Absolute: `Bun.resolveSync` reads a relative directory against nothing useful.
  const base = resolve(root);
  const masked = maskLiterals(source);
  let specifiers: readonly string[];
  try {
    specifiers = scanAllImports({ path, source }, masked);
  } catch {
    // A file that does not parse imports nothing we can read: it may import anything.
    return { imports: [], opaque: true };
  }
  const imports = new Set<string>();
  for (const specifier of specifiers) {
    let resolved: string;
    try {
      resolved = Bun.resolveSync(specifier, dirname(join(base, path)));
    } catch {
      // Unresolvable: the module's own import fails first, and loudly.
      continue;
    }
    const inside = toPosix(relative(base, resolved));
    if (!inside.startsWith('../') && !skipped(inside)) imports.add(inside);
  }
  return { imports: [...imports].sort(), opaque: COMPUTED_IMPORT.test(masked) };
}

/**
 * The app's own test preloads (`bunfig.toml`'s `[test] preload`): Bun imports each before EVERY
 * test file, so each is an import of every test — the edge no source spells.
 */
async function testPreloads(root: string): Promise<readonly string[]> {
  const bunfig = Bun.file(join(root, 'bunfig.toml'));
  if (!(await bunfig.exists())) return [];
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(await bunfig.text());
  } catch {
    // An unparseable bunfig fails every `bun test` first; no edge is better than a guessed one.
    return [];
  }
  const preload = (parsed as { readonly test?: { readonly preload?: unknown } }).test?.preload;
  const listed = Array.isArray(preload) ? preload : typeof preload === 'string' ? [preload] : [];
  return fileImports(
    root,
    'bunfig.ts',
    listed.map((entry) => `import ${JSON.stringify(String(entry))};`).join('\n'),
  ).imports;
}

/** Every file's facts. `primitives` is filled by `primitiveFiles` once the app has loaded. */
export async function moduleFiles(root: string): Promise<ModuleFacts['files']> {
  const preloads = await testPreloads(root);
  const files: ModuleFacts['files'][number][] = [];
  for (const path of await appSourceFiles(root)) {
    const source = await Bun.file(join(root, path)).text();
    const found = fileImports(root, path, source);
    const test = isTest(path);
    const imports = test ? [...new Set([...found.imports, ...preloads])].sort() : found.imports;
    files.push({ path, imports, opaque: found.opaque, test });
  }
  return files;
}

type Primitive = ModuleFacts['primitives'][number];

const BARREL = /(?:^|\/)index\.tsx?$/;

/**
 * The modules asked for their exports: the ones `loadApp` imported, and the app's own workspace
 * libraries (`packages/<name>/src/`, where an entity is declared). Never a script or a guard —
 * importing one RUNS it.
 */
const IMPORTABLE = /^(?:apps\/[^/]+\/(?:app|site|api|shared)\/|packages\/[^/]+\/src\/).*\.tsx?$/;

/**
 * Which file declares which primitive, by IDENTITY: each loaded module's exports compared with the
 * handles the registries hold — never a parse of the source for a call. Routes carry their file.
 * Call after `loadApp`: Bun's module cache answers each import without evaluating it again.
 */
export async function primitiveFiles(
  root: string,
  files: readonly string[],
): Promise<readonly Primitive[]> {
  const handles = new Map<unknown, Omit<Primitive, 'file'>>();
  for (const { name } of describeActions()) handles.set(getAction(name), { kind: 'action', name });
  for (const { name } of describeQueries()) handles.set(getQuery(name), { kind: 'query', name });
  for (const job of registeredJobs()) handles.set(job, { kind: 'job', name: job.name });
  for (const task of registeredTasks()) handles.set(task, { kind: 'task', name: task.name });
  for (const entity of registeredEntities()) {
    if (entity.core !== undefined) handles.set(entity.core, { kind: 'entity', name: entity.name });
  }
  const found = new Map<string, Primitive>();
  for (const route of routeEntries()) {
    const file = toPosix(route.file);
    found.set(`route:${route.path}`, { kind: 'route', name: route.path, file });
  }
  for (const file of files) {
    if (isTest(file) || !IMPORTABLE.test(file)) continue;
    let module: Readonly<Record<string, unknown>>;
    try {
      module = (await import(join(root, file))) as Readonly<Record<string, unknown>>;
    } catch {
      // A module that will not load declares nothing here; `x verify`'s manifest step names it.
      continue;
    }
    for (const value of Object.values(module)) {
      const handle = handles.get(value);
      const key = handle === undefined ? undefined : `${handle.kind}:${handle.name}`;
      if (handle === undefined || key === undefined) continue;
      // A barrel re-exports the handle its declaring module exports: the declaring file wins.
      const held = found.get(key);
      if (held === undefined || (BARREL.test(held.file) && !BARREL.test(file))) {
        found.set(key, { ...handle, file });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    `${a.kind}:${a.name}` < `${b.kind}:${b.name}` ? -1 : 1,
  );
}

/** Root-level files the framework READS rather than imports: a change re-checks everything. */
const READ_NOT_IMPORTED = new Set([
  'app.config.ts',
  'bunfig.toml',
  'package.json',
  'tsconfig.json',
]);

export interface TestSelection {
  /** Root-relative test files, sorted. Every test when `all`. */
  readonly tests: readonly string[];
  /** `true` when a changed file decides nothing by import alone, so every test runs. */
  readonly all: boolean;
  /** The changed files that forced `all`. */
  readonly forcing: readonly string[];
}

/**
 * The tests a change can break: a test runs unless its import closure misses every changed file.
 * A superset by construction — a test importing an opaque file always runs, and a changed file
 * the import graph cannot speak for (config read at boot, a catalog, a lockfile, anything outside
 * the app) runs everything. A `.md` reaches nothing.
 */
export function selectTests(
  files: ModuleFacts['files'],
  changed: readonly string[],
): TestSelection {
  const known = new Set(files.map((file) => file.path));
  // Outside the app, read at boot, deleted, or no source at all: the import graph cannot speak for
  // it. A deleted module's importers are no longer on record either, so it forces too.
  const forcing = changed.filter(
    (path) =>
      !path.endsWith('.md') &&
      (path.startsWith('../') || READ_NOT_IMPORTED.has(path) || !known.has(path)),
  );
  const allTests = files.filter((file) => file.test).map((file) => file.path);
  if (forcing.length > 0) return { tests: allTests, all: true, forcing };
  const importers = new Map<string, string[]>();
  for (const file of files) {
    for (const target of file.imports) {
      const list = importers.get(target);
      if (list === undefined) importers.set(target, [file.path]);
      else list.push(file.path);
    }
  }
  const reached = new Set(changed.filter((path) => known.has(path)));
  for (const file of files) if (file.opaque) reached.add(file.path);
  const queue = [...reached];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const importer of importers.get(at) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return { tests: allTests.filter((test) => reached.has(test)), all: false, forcing: [] };
}
