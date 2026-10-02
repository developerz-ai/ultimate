// The files one module's source imports, resolved the way Bun will resolve them. One function for
// the two graphs built over it: the reload graph (`app-reload-graph.ts`), which follows every file
// a module NAMES, and the document graph (`document-graph.ts`), which follows only what
// EVALUATING the module evaluates. Each caller keeps its own rule for which targets it walks.

// why: Bun ships no path API; an import specifier resolves against the importing file's directory.
import { dirname } from 'node:path';

/**
 * `referenced`: every file the module names, an `await import()` target included — a save to one
 * must reload its importer. `evaluated`: what importing the module evaluates, so the lazy targets
 * are left out. Each keeps the transpiler pass its graph was built on (`scanImports`, the fast
 * one, and `scan`); measured on Bun 1.4.0 the two agree on every static shape — both drop
 * `import type` and an inline `type` specifier, both keep a value import used only as a type.
 */
export type ImportEdges = 'referenced' | 'evaluated';

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

/**
 * Absolute paths, in source order. A file that will not parse imports nothing yet, and a
 * specifier that will not resolve contributes no edge: the module's own import reports both.
 */
export function resolvedImports(path: string, source: string, edges: ImportEdges): string[] {
  const transpiler = path.endsWith('x') ? transpilers.tsx : transpilers.ts;
  let specifiers: readonly { readonly path: string; readonly kind: string }[];
  try {
    specifiers =
      edges === 'referenced'
        ? transpiler.scanImports(source)
        : transpiler.scan(source).imports.filter((one) => one.kind !== 'dynamic-import');
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const { path: specifier } of specifiers) {
    try {
      found.push(Bun.resolveSync(specifier, dirname(path)));
    } catch {
      // Unresolvable: no edge.
    }
  }
  return found;
}
