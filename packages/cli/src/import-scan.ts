// The one import scanner: Bun's transpiler, fed the source with type-only imports rewritten so it
// reports them too. A leaf — it imports nothing — so `scripts/boundaries.ts`, which must run with
// no `node_modules`, reads it by path. A regex scanner beside it read a nested template's
// `import … from '@ultimat3/ui'` as the generator's own import (#493); the transpiler never does.

/** A file as the scanners take it: repo-relative POSIX path and its text. */
export interface ScannedFile {
  readonly path: string;
  readonly source: string;
}

/** The transpiler rejects a shebang, and a `bin.ts` legitimately has one. */
export const stripShebang = (source: string): string =>
  source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;

/**
 * `scanImports` ERASES `import type` / `export type`. Dropping the keyword before the parse makes
 * the transpiler report one as an ordinary import. The lookahead keeps `export type Foo = string`
 * — an alias, not an import — from becoming a syntax error.
 */
const TYPE_ONLY_CLAUSE = /\b(import|export)\s+type\s+(?=[{*]|[A-Za-z_$][\w$]*\s+from\b)/g;

export const dropTypeKeyword = (source: string): string => source.replace(TYPE_ONLY_CLAUSE, '$1 ');

/**
 * The inline spelling `import { type Foo } from 'x'`, whose whole list is type-only and so erased.
 * The list is DELETED rather than de-`type`d — deciding which `type` is a modifier is the parser's
 * job — and a side-effect import carries the one thing a scan reads, the specifier.
 */
const BRACE_IMPORT =
  /(^|[\s;}])(?:import|export)\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^{}]*\}\s*from\s*(['"])([^'"\n]+)\2/g;

export const asSideEffectImports = (source: string): string =>
  source.replace(BRACE_IMPORT, '$1import $2$3$2');

const loaderOf = (path: string): 'ts' | 'tsx' => (path.endsWith('x') ? 'tsx' : 'ts');

/** What survives type erasure: static, re-export, side-effect and dynamic imports, and `require`. */
export function scanRuntimeImports(file: ScannedFile): readonly string[] {
  return new Bun.Transpiler({ loader: loaderOf(file.path) })
    .scanImports(stripShebang(file.source))
    .map((entry) => entry.path);
}

/**
 * Every specifier the file names, type-only ones included. Throws when the file does not parse —
 * a scan that answered `[]` there would read as a file importing nothing. The rewrite pass alone
 * is forgiving: a rewrite the parser refuses falls back to the runtime scan.
 */
export function scanAllImports(file: ScannedFile): readonly string[] {
  const runtime = scanRuntimeImports(file);
  let typed: readonly string[] = [];
  try {
    const rewritten = asSideEffectImports(dropTypeKeyword(stripShebang(file.source)));
    typed = new Bun.Transpiler({ loader: loaderOf(file.path) })
      .scanImports(rewritten)
      .map((entry) => entry.path);
  } catch {
    typed = [];
  }
  // The rewritten pass first: it holds every import in SOURCE order, which callers report in.
  return [...new Set([...typed, ...runtime])];
}
