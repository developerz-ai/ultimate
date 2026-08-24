// What an app DECLARES, as a flat list of keys: every leaf field of every type a primitive or a
// `define*` factory takes as its declaration. The roots are derived from the factory signatures
// themselves — a hand list of them is the defect this scan exists to catch, one level up — and a
// type name resolves inside its OWN package, because two packages naming an interface the same
// thing is ordinary and resolving across them walks fields the root has never had.

import { PRIMITIVE_KINDS } from '@ultimat3/core';

export interface DeclarationSource {
  readonly path: string;
  /** Source with string CONTENTS blanked and every offset preserved. See `maskLiterals`. */
  readonly text: string;
}

export interface InterfaceBody {
  readonly body: string;
  readonly path: string;
}

export interface DeclaredLeaf {
  /** The declaration type a factory takes, e.g. `RouteDefinition`. */
  readonly root: string;
  /** Dotted from the root: `RouteDefinition.budget.cls`. */
  readonly leaf: string;
  /** The last segment, which is what a reader spells. */
  readonly key: string;
  /** The file declaring the interface this key sits on. */
  readonly path: string;
  readonly pkg: string;
}

/** `packages/render/src/route.ts` -> `render`. Empty outside `packages/`, which never matches. */
export const packageOfPath = (path: string): string =>
  path.startsWith('packages/') ? (path.split('/')[1] ?? '') : '';

const INTERFACE = /export interface (\w+)(?:<[^>]*>)?\s*(?:extends [^{]+)?\{([\s\S]*?)\n\}/g;
/** A member at one indent level, the same shape `config-readers.ts` walks `AppConfig` with. */
const MEMBER = /^ {2}readonly\s+([A-Za-z_$][\w$]*)\??\s*:\s*([^;]+);/gm;
/** A member whose type is a single named interface — the one shape the walk descends into. */
const NAMED = /^([A-Z]\w*)$/;

/**
 * `<package>::<Name>` -> its body. FIRST declaration wins, and the key carries the package for the
 * reason above: `RetryConfig` is declared in `@ultimat3/jobs` and in `@ultimat3/ai`, and a global
 * table resolved `JobDefinition.retry` to the gateway's fields — two leaves reported as dead that
 * `@ultimat3/jobs` has never declared.
 */
export function interfaceTable(
  files: readonly DeclarationSource[],
): ReadonlyMap<string, InterfaceBody> {
  const table = new Map<string, InterfaceBody>();
  for (const file of files) {
    for (const match of file.text.matchAll(INTERFACE)) {
      const key = `${packageOfPath(file.path)}::${match[1] as string}`;
      if (!table.has(key)) table.set(key, { body: match[2] as string, path: file.path });
    }
  }
  return table;
}

/**
 * `AppConfigInput` is `AppConfig`'s input twin and `scripts/config-readers.ts` already walks it.
 * One key, one rule, one edit — two rules reporting the same dead key is two findings for one
 * repair, and the `Input<T>` wrapper stops this walk one level higher than that one anyway, so the
 * three leaves it reported were the wrapper and not the keys.
 */
export const DECLARATION_ROOTS_OWNED_ELSEWHERE: readonly string[] = ['AppConfigInput'];

/**
 * A function that opens a declaration: one of the eight primitives, `can` (policy's), or any
 * `define*`. Derived from `PRIMITIVE_KINDS` so a ninth primitive cannot be invisible here — the
 * list is core's, never restated.
 */
const ROOT_FACTORY = new RegExp(`^(?:define[A-Z]|can$|(?:${PRIMITIVE_KINDS.join('|')})$)`);

/**
 * The first TWO parameter types of an exported function or arrow. Two, because the name-first
 * factories — `entity(name, init)`, `defineService(name, factory)`, `defineSeed(name, run)` — put
 * the declaration second, and reading only the first would silently drop `EntityInit`.
 */
const FUNCTION_ROOT =
  /export (?:async )?function (\w+)\s*(?:<[^>]*>)?\(\s*\w+\s*:\s*([A-Za-z_$][\w$]*)[^)]*?(?:,\s*\w+\s*:\s*([A-Za-z_$][\w$]*))?/g;
const ARROW_ROOT =
  /export const (\w+)\s*=\s*(?:<[^>]*>)?\(\s*\w+\s*:\s*([A-Za-z_$][\w$]*)[^)]*?(?:,\s*\w+\s*:\s*([A-Za-z_$][\w$]*))?/g;

/** Every `<package>::<Name>` a declaration factory accepts, sorted so the walk is deterministic. */
export function declarationRoots(
  files: readonly DeclarationSource[],
  table: ReadonlyMap<string, InterfaceBody>,
): readonly string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const pkg = packageOfPath(file.path);
    for (const pattern of [FUNCTION_ROOT, ARROW_ROOT]) {
      for (const match of file.text.matchAll(pattern)) {
        if (!ROOT_FACTORY.test(match[1] as string)) continue;
        for (const type of [match[2], match[3]]) {
          if (type === undefined || DECLARATION_ROOTS_OWNED_ELSEWHERE.includes(type)) continue;
          if (table.has(`${pkg}::${type}`)) roots.add(`${pkg}::${type}`);
        }
      }
    }
  }
  return [...roots].sort();
}

/** Every leaf key of every declaration root, dotted. */
export function declarationLeaves(files: readonly DeclarationSource[]): readonly DeclaredLeaf[] {
  const table = interfaceTable(files);
  const leaves: DeclaredLeaf[] = [];
  const walk = (key: string, root: string, prefix: string, seen: readonly string[]): void => {
    const entry = table.get(key);
    // A cycle would recurse forever, and a self-referential declaration is a thing this tree does
    // have (`RouteDefinition.load` returning a route context); a check that hangs is worse than one
    // that stops early.
    if (entry === undefined || seen.includes(key)) return;
    const pkg = packageOfPath(entry.path);
    for (const member of entry.body.matchAll(MEMBER)) {
      const name = member[1] as string;
      const type = (member[2] as string).trim();
      const target = NAMED.test(type) ? `${pkg}::${type}` : undefined;
      if (target !== undefined && table.has(target)) {
        walk(target, root, `${prefix}${name}.`, [...seen, key]);
        continue;
      }
      leaves.push({ root, leaf: `${prefix}${name}`, key: name, path: entry.path, pkg });
    }
  };
  for (const root of declarationRoots(files, table)) {
    const name = root.split('::').at(-1) as string;
    walk(root, name, `${name}.`, []);
  }
  return leaves;
}
