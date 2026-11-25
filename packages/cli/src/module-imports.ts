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

/** Every specifier `source` names, as written and in source order. Unparseable: it names none yet. */
export function importedSpecifiers(
  path: string,
  source: string,
  edges: ImportEdges,
): readonly string[] {
  const transpiler = path.endsWith('x') ? transpilers.tsx : transpilers.ts;
  try {
    const imports =
      edges === 'referenced'
        ? transpiler.scanImports(source)
        : transpiler.scan(source).imports.filter((one) => one.kind !== 'dynamic-import');
    return imports.map((one) => one.path);
  } catch {
    return [];
  }
}

/** The file `specifier` is from `path`, as Bun resolves it — `undefined` when it resolves to none. */
export function resolveImport(specifier: string, path: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dirname(path));
  } catch {
    return undefined;
  }
}

/**
 * Absolute paths, in source order. A file that will not parse imports nothing yet, and a
 * specifier that will not resolve contributes no edge: the module's own import reports both.
 */
export function resolvedImports(path: string, source: string, edges: ImportEdges): string[] {
  return importedSpecifiers(path, source, edges).flatMap(
    (specifier) => resolveImport(specifier, path) ?? [],
  );
}
