// A package barrel a browser must not import, and the entry it imports instead. `@ultimat3/entity`'s
// barrel reaches the SQL renderer and `@ultimat3/db` — about a megabyte in an island — while
// `@ultimat3/entity/record` is the browser half. DERIVED from each manifest's `exports`: a package
// that publishes a `./record`, `./browser` or `./client` subpath has said its barrel is the server
// half, so a new browser entry enters this rule by being published, never by being listed here.

import { stripComments } from '@ultimat3/core';
import { lineOf } from './source-scan';

/** The subpath names that declare "this is the browser entry of the package". */
export const BROWSER_ENTRY_SUBPATHS: ReadonlySet<string> = new Set(['record', 'browser', 'client']);

/** Barrel specifier → the browser entry that replaces it, read off the published specifiers. */
export function serverBarrels(specifiers: Iterable<string>): ReadonlyMap<string, string> {
  const barrels = new Map<string, string>();
  for (const spec of specifiers) {
    const match = /^(@[\w-]+\/[\w-]+)\/([\w-]+)$/.exec(spec);
    if (match?.[1] === undefined || !BROWSER_ENTRY_SUBPATHS.has(match[2] ?? '')) continue;
    barrels.set(match[1], spec);
  }
  return barrels;
}

export interface BarrelImport {
  readonly line: number;
  readonly barrel: string;
  readonly entry: string;
}

/** `import` / `export … from` / `import()` of a VALUE from the barrel. `import type` runs nothing. */
const IMPORTS =
  /\b(?:import|export)\s+(?!type\s)[^;'"]*?\bfrom\s*(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)/g;

export function barrelImports(
  source: string,
  barrels: ReadonlyMap<string, string>,
): readonly BarrelImport[] {
  const code = stripComments(source);
  const found: BarrelImport[] = [];
  for (const match of code.matchAll(IMPORTS)) {
    const spec = match[2] ?? match[4] ?? '';
    const entry = barrels.get(spec);
    if (entry === undefined) continue;
    // `import { type A, type B } from …` binds nothing at runtime either.
    const clause = /\{([^}]*)\}/.exec(match[0])?.[1];
    const typesOnly = clause?.split(',').every((part) => /^\s*(?:type\s|$)/.test(part));
    if (typesOnly === true) continue;
    found.push({ line: lineOf(code, match.index), barrel: spec, entry });
  }
  return found;
}
