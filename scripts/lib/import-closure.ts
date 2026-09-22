// The modules a set of entry files can EXECUTE, followed name by name through barrels. A package
// barrel re-exports its whole surface by name (the house forbids `export *`), so a closure taken
// module by module reaches every server file of every package an island touches — `@ultimat3/action`'s
// barrel reaches `http.ts` — while a bundler with honest `sideEffects` keeps only the modules the
// imported NAMES live in. This follows the names, which is what makes "browser-reachable" a
// question with a useful answer instead of "everything".
//
// Pure over an injected reader, so a test's fixture tree is a Map rather than files on disk.

import { stripComments } from '@ultimat3/core';

/** What a module asks of another: named bindings, or the whole module (`*`). */
export type Wanted = '*' | ReadonlySet<string>;

export interface ModuleShape {
  /** `import … from`, `import('x')` — followed only when this module's body runs. */
  readonly imports: readonly { readonly spec: string; readonly names: Wanted }[];
  /** `export { local as exported } from 'x'` — followed only for the names somebody wants. */
  readonly reexports: readonly {
    readonly spec: string;
    readonly map: ReadonlyMap<string, string>;
  }[];
  /** `export * from 'x'` — searched for a wanted name this module does not name itself. */
  readonly stars: readonly string[];
  /** `import 'x'` — runs whenever this module is touched at all, which is what a barrel's is for. */
  readonly effects: readonly string[];
}

export interface ClosureHost {
  /** The file's text, or `undefined` when there is no such file. Paths are repo-relative POSIX. */
  read(path: string): string | undefined;
  /** A bare specifier's file (`@ultimat3/core` → `packages/core/src/index.ts`), or `undefined`. */
  alias(spec: string, from: string): string | undefined;
}

const IMPORT_FROM = /\bimport\s+(?!type\s)([^;'"]*?)\s*from\s*(['"])([^'"]+)\2/g;
const IMPORT_BARE = /\bimport\s*(['"])([^'"]+)\1/g;
const IMPORT_DYNAMIC = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const EXPORT_FROM = /\bexport\s+(?!type\s)\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
const EXPORT_STAR = /\bexport\s+\*\s*(?:as\s+[\w$]+\s*)?from\s*(['"])([^'"]+)\1/g;

/** `a, type b, c as d` → the value names, `type` members dropped. */
const members = (list: string): readonly (readonly [string, string])[] =>
  list
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith('type '))
    .map((part) => {
      const [local = part, exported = local] = part.split(/\s+as\s+/);
      return [local.trim(), exported.trim()] as const;
    });

/** The names an import clause binds: `default`, the braced members, or `*` for a namespace. */
function clauseNames(clause: string): Wanted {
  if (/\*\s*as\s/.test(clause)) return '*';
  const names = new Set<string>();
  const braced = /\{([^}]*)\}/.exec(clause);
  for (const [local] of members(braced?.[1] ?? '')) names.add(local);
  const head = clause
    .replace(/\{[^}]*\}/, '')
    .replace(/,/g, ' ')
    .trim();
  if (head.length > 0) names.add('default');
  return names;
}

export function parseModule(source: string): ModuleShape {
  const code = stripComments(source);
  const imports: { spec: string; names: Wanted }[] = [];
  for (const found of code.matchAll(IMPORT_FROM)) {
    const names = clauseNames(found[1] ?? '');
    // `import type { A }` is caught above; `import { type A }` alone binds nothing at runtime.
    if (names !== '*' && names.size === 0) continue;
    imports.push({ spec: found[3] ?? '', names });
  }
  const effects = [...code.matchAll(IMPORT_BARE)].map((found) => found[2] ?? '');
  for (const found of code.matchAll(IMPORT_DYNAMIC)) {
    imports.push({ spec: found[2] ?? '', names: '*' });
  }
  const reexports = [...code.matchAll(EXPORT_FROM)].map((found) => ({
    spec: found[3] ?? '',
    map: new Map(members(found[1] ?? '').map(([local, exported]) => [exported, local])),
  }));
  const stars = [...code.matchAll(EXPORT_STAR)].map((found) => found[2] ?? '');
  return { imports, reexports, stars, effects };
}

const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** A relative specifier against the importing file, extension-less as TypeScript writes it. */
function resolveRelative(host: ClosureHost, from: string, spec: string): string | undefined {
  const base = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  const joined = base.join('/').replace(/\.js$/, '');
  for (const suffix of CANDIDATES) {
    const path = `${joined}${suffix}`;
    if (/\.tsx?$/.test(path) && host.read(path) !== undefined) return path;
  }
  return undefined;
}

export function resolveSpec(host: ClosureHost, from: string, spec: string): string | undefined {
  return spec.startsWith('.') ? resolveRelative(host, from, spec) : host.alias(spec, from);
}

/**
 * Every module whose BODY an entry set can run. A module reached only for names it re-exports is
 * passed through, not included: its own statements are the re-export lines and nothing else.
 */
export function importClosure(host: ClosureHost, entries: readonly string[]): readonly string[] {
  const shapes = new Map<string, ModuleShape>();
  const bodies = new Set<string>();
  const asked = new Map<string, Set<string>>();
  const queue: { path: string; names: Wanted }[] = entries.map((path) => ({ path, names: '*' }));

  const shapeOf = (path: string): ModuleShape | undefined => {
    const known = shapes.get(path);
    if (known !== undefined) return known;
    const source = host.read(path);
    if (source === undefined) return undefined;
    const shape = parseModule(source);
    shapes.set(path, shape);
    return shape;
  };
  const follow = (from: string, spec: string, names: Wanted): void => {
    const path = resolveSpec(host, from, spec);
    if (path !== undefined) queue.push({ path, names });
  };

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { path, names } = next;
    const shape = shapeOf(path);
    if (shape === undefined) continue;
    let needsBody = names === '*';
    const seen = asked.get(path) ?? new Set<string>();
    if (!asked.has(path)) for (const effect of shape.effects) follow(path, effect, '*');
    asked.set(path, seen);
    for (const name of names === '*' ? [] : names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const source = shape.reexports.find((entry) => entry.map.has(name));
      if (source !== undefined) {
        follow(path, source.spec, new Set([source.map.get(name) ?? name]));
        continue;
      }
      needsBody = true;
      for (const star of shape.stars) follow(path, star, new Set([name]));
    }
    if (names === '*') {
      for (const entry of shape.reexports) follow(path, entry.spec, new Set(entry.map.values()));
      for (const star of shape.stars) follow(path, star, '*');
    }
    if (!needsBody || bodies.has(path)) continue;
    bodies.add(path);
    for (const entry of shape.imports) follow(path, entry.spec, entry.names);
  }
  return [...bodies].sort();
}
