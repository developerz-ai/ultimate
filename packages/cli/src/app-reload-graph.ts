// Which modules a rescan must evaluate again, and making Bun do it. `import()` caches by path for
// the life of the process, so a re-import sees the edited file only once that path has left Bun's
// module registry (`delete require.cache[path]`, which Bun 1.4 honours for ES modules too). Until
// 2026-09-27 `x dev` re-imported only the edited ROUTE module, under `?x-reload=<hash>`, and every
// module that route imports resolved to the instance already cached: a save to a component, its
// `.module.scss` or a helper logged "reloaded" and rendered the old code until a restart
// (notificado.co: the panel's balance card and the home page, observed twice on one day).
//
// The rule is a reverse-dependency closure. A rescan hashes every file this graph knows; each
// changed file, and every module that imports it transitively, leaves the registry, and the scan's
// own `import()` of each app module then evaluates the new chain. Evicting the entry — rather than
// a query per save — is also what keeps the process flat: the replaced instance has no referrer
// once the route table holds the new page, and is collected. A query key is a new registry entry
// per save, never freed.
//
// A module that DEFINES a primitive is PINNED and never leaves the registry: its exports are held
// by every importer and by a registry that refuses a second definition of one name (an entity is
// `X_ENTITY_DUPLICATE`; a second action instance is a handler nobody routes to). The closure stops
// at a pinned module, and an edit to one still needs a restart — exactly what it needed before.

// why: Bun ships no path API; import specifiers resolve against the importing file's directory.
import { dirname, resolve } from 'node:path';
import { registeredStylesheets } from '@ultimat3/render/server';
import { hasPathSegment } from './path-segments';

type Kind = 'script' | 'style' | 'data';

interface Node {
  readonly kind: Kind;
  /** `null`: the file is gone. A deleted file is a change too — its importers must fail loudly. */
  hash: bigint | null;
  /** The in-app files this one imports (a sheet: the partials its compilation read). */
  deps: Set<string>;
}

const nodes = new Map<string, Node>();
/** Reverse edges: file → the files that import it. */
const importers = new Map<string, Set<string>>();
const pinned = new Set<string>();
/**
 * Edges cost a transpile scan and a resolve per import (~300 ms over notificado.co's 1200 modules),
 * so only the one process that rescans pays it: `x dev` turns this on before its first scan. Off,
 * a rescan still re-evaluates each changed module itself — a route saved in place reloads — but
 * nothing it is imported by.
 */
let tracking = false;

export function enableReloadTracking(on: boolean): void {
  tracking = on;
}

/** Test seam, and `resetAppLoad`'s: forget every file, edge and pin. */
export function resetReloadGraph(): void {
  nodes.clear();
  importers.clear();
  pinned.clear();
}

/** Marks a module that defines a primitive: never evicted, and the closure stops at it. */
export function pinModule(absolute: string): void {
  pinned.add(absolute);
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const STYLE = /\.(?:s[ac]ss|css)$/;

const kindOf = (path: string): Kind =>
  SCRIPT.test(path) ? 'script' : STYLE.test(path) ? 'style' : 'data';

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

const readText = async (path: string): Promise<string | null> => {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
};

const hashOf = (text: string | null): bigint | null =>
  text === null ? null : BigInt(Bun.hash.wyhash(text));

/** The in-app files `source` imports — a package under `node_modules` is not the app's to reload. */
function importsOf(path: string, source: string, root: string): string[] {
  let specifiers: readonly { readonly path: string }[];
  try {
    const transpiler = path.endsWith('x') ? transpilers.tsx : transpilers.ts;
    specifiers = transpiler.scanImports(source);
  } catch {
    // A file that will not parse imports nothing yet; its own hash still changes on the fix.
    return [];
  }
  const found: string[] = [];
  for (const { path: specifier } of specifiers) {
    let target: string;
    try {
      target = Bun.resolveSync(specifier, dirname(path));
    } catch {
      continue;
    }
    if (target.startsWith(`${root}/`) && !hasPathSegment(target, 'node_modules')) {
      found.push(target);
    }
  }
  return found;
}

function link(from: string, to: string): void {
  let set = importers.get(to);
  if (set === undefined) {
    set = new Set();
    importers.set(to, set);
  }
  set.add(from);
}

function unlink(from: string, node: Node): void {
  for (const dep of node.deps) importers.get(dep)?.delete(from);
  node.deps = new Set();
}

async function edges(path: string, node: Node, source: string, root: string): Promise<void> {
  unlink(path, node);
  for (const dep of importsOf(path, source, root)) {
    node.deps.add(dep);
    link(path, dep);
    if (!nodes.has(dep)) await track(dep, await readText(dep), root);
  }
}

/**
 * Records `absolute` as it reads NOW — `source` is the text the caller is about to import, read
 * before the import, so a save landing mid-import is a change on the next rescan rather than a
 * hash bound to bytes that were never evaluated.
 */
export async function trackModule(absolute: string, source: string, root: string): Promise<void> {
  await track(absolute, source, resolve(root));
}

async function track(path: string, source: string | null, root: string): Promise<void> {
  const node: Node = nodes.get(path) ?? { kind: kindOf(path), hash: null, deps: new Set() };
  nodes.set(path, node);
  node.hash = hashOf(source);
  if (tracking && node.kind === 'script' && source !== null) await edges(path, node, source, root);
}

/**
 * After a scan: every sheet the loader compiled, and an edge from each partial it read to it. A
 * partial is not a module — nothing imports it — so this is the only place its edits are seen.
 */
export async function trackStylesheets(root: string): Promise<void> {
  if (!tracking) return;
  const base = resolve(root);
  const inApp = (path: string): boolean =>
    path.startsWith(`${base}/`) && !hasPathSegment(path, 'node_modules');
  for (const sheet of registeredStylesheets()) {
    if (!inApp(sheet.file)) continue;
    if (!nodes.has(sheet.file)) await track(sheet.file, await readText(sheet.file), base);
    const node = nodes.get(sheet.file);
    if (node === undefined) continue;
    for (const dep of sheet.dependencies) {
      if (!inApp(dep)) continue;
      node.deps.add(dep);
      link(sheet.file, dep);
      if (!nodes.has(dep)) await track(dep, await readText(dep), base);
    }
  }
}

/** Every file that changed since it was recorded, re-recorded as it reads now. */
async function changedFiles(root: string): Promise<string[]> {
  const known = [...nodes.keys()];
  const texts = await Promise.all(known.map(readText));
  const changed: string[] = [];
  for (const [index, path] of known.entries()) {
    const node = nodes.get(path);
    const text = texts[index] ?? null;
    if (node === undefined || hashOf(text) === node.hash) continue;
    changed.push(path);
    await track(path, text, root);
  }
  return changed;
}

/** `changed` and everything above it, stopping at — and excluding — every pinned module. */
function closure(changed: readonly string[]): Set<string> {
  const dirty = new Set<string>();
  const stack = changed.filter((path) => !pinned.has(path));
  while (stack.length > 0) {
    const path = stack.pop();
    if (path === undefined || dirty.has(path)) continue;
    dirty.add(path);
    for (const importer of importers.get(path) ?? []) {
      if (!pinned.has(importer)) stack.push(importer);
    }
  }
  return dirty;
}

/**
 * The start of a rescan: evicts every changed module and its importers from Bun's registry, so
 * the scan's `import()` evaluates them again. A sheet is re-imported here as well, because a
 * partial's edit changes no importer's text — the loader's `onLoad` is what re-registers its CSS.
 * Returns the evicted paths.
 */
export async function evictChanged(root: string): Promise<ReadonlySet<string>> {
  const dirty = closure(await changedFiles(resolve(root)));
  const reloadSheets: string[] = [];
  for (const path of dirty) {
    // A sheet the process never loaded (a partial) has nothing for its own import to refresh.
    if (nodes.get(path)?.kind === 'style' && path in require.cache) reloadSheets.push(path);
    // Unconditionally: a module whose import FAILED is absent from `require.cache` and still held
    // by Bun's loader — measured on 1.4.0, the fixed file kept throwing the old parse error until
    // this delete, which clears that entry too.
    delete require.cache[path];
  }
  for (const sheet of reloadSheets) {
    try {
      await import(sheet);
    } catch {
      // Reported where it matters: the module that imports the sheet fails its import, at its file.
    }
  }
  return dirty;
}
