// A fix-building helper the calling file did not declare: `invalidIconDataError` lives in
// `packages/ui/src/errors.ts` and every fix it is handed is written in `icons/build-icons.ts`.
// One specifier, one file read, one parameter position — deliberately still not `tsc`.

// `dirname`/`join` are `node:`-only by necessity: Bun exposes no path-join primitive.
import { dirname, join } from 'node:path';
import type { FixHelper } from './fix-scan';
import { scanFixHelpers } from './fix-scan';
import { endOfLiteral, maskLiterals } from './ts-scan';

/**
 * A named import, matched over the MASKED source and anchored at the start of a line, so an
 * `import …` written inside a template literal is not read as one — `packages/cli/src/templates/`
 * emits a dozen of them as generated app source, and resolving those pointed the scan at a module
 * that only exists in the app the template writes. Masking blanks a literal's contents and keeps
 * its delimiters, so the specifier is read back out of the raw source at the quote's own offset.
 *
 * `import type` is skipped whole: a type has no call site. A default or namespace import is not
 * matched at all — this repo ships no default exports, and `errors.raise(…)` is a member access
 * that `helperFixSites` refuses by design.
 */
const IMPORT_CLAUSE = /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]/gm;

/** `a`, `a as b`, and the inline `type a` that carries no value. */
const parseClause = (clause: string): { readonly exported: string; readonly local: string }[] =>
  clause
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^type\s/.test(part))
    .map((part) => {
      const [exported, local] = part.split(/\s+as\s+/);
      return { exported: (exported ?? '').trim(), local: (local ?? exported ?? '').trim() };
    })
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name.exported) && name.local !== '');

interface LocalImport {
  readonly specifier: string;
  readonly names: readonly { readonly exported: string; readonly local: string }[];
}

/** Every value import in this file, specifier as written. */
export function scanImports(source: string): readonly LocalImport[] {
  const masked = maskLiterals(source);
  const imports: LocalImport[] = [];
  for (const match of masked.matchAll(IMPORT_CLAUSE)) {
    if (match[1] !== undefined) continue;
    const names = parseClause(match[2] ?? '');
    const quote = match.index + match[0].length - 1;
    const specifier = source.slice(quote + 1, endOfLiteral(masked, quote) - 1);
    if (names.length > 0 && specifier !== '') imports.push({ specifier, names });
  }
  return imports;
}

/**
 * The repo-relative paths a relative specifier could name, in resolution order. Only relative
 * ones: `@ultimat3/db` and `node:path` are somebody else's file set, and a scanner that guessed
 * which package a bare name came from would read an unrelated function's argument as a fix. That
 * gap is real and named — `x verify`'s `errors` step counts what it could not read rather than
 * passing over it silently, which is the failure this file exists to end.
 */
export function candidatePaths(from: string, specifier: string): readonly string[] {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
  const base = join(dirname(from), specifier);
  // A path that climbed out of the repo root is not a file this scan may open.
  if (base.startsWith('..')) return [];
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
}

/**
 * The helpers one file can call, named as that file names them.
 *
 * Deliberately NOT also a count of the imports it could not open: that number is 1504 in this
 * repo and 1310 of them are `@ultimat3/*` names like `join` and `UltimateError` — a figure nobody
 * can act on. What the gate reports instead is `FixScan.unreadable`, which counts only arguments
 * in a KNOWN fix position, and is therefore a count of fixes rather than of imports.
 */
export type HelperResolver = (path: string, source: string) => Promise<readonly FixHelper[]>;

/**
 * One resolver per run, because the module cache is the whole point: `packages/ui/src/errors.ts`
 * is imported by every file in the package, and re-reading and re-scanning it per importer turns
 * a one-pass walk into a quadratic one.
 *
 * A name declared in the imported module wins by NAME alone — no export check. The tree
 * typechecks, so a name this file imports is a name that module exports; a second rule reading
 * `export` keywords would only be able to disagree with `tsc`, never to add anything.
 */
export function createHelperResolver(root: string): HelperResolver {
  const modules = new Map<string, readonly FixHelper[] | undefined>();

  const helpersIn = async (path: string): Promise<readonly FixHelper[] | undefined> => {
    const cached = modules.get(path);
    if (cached !== undefined || modules.has(path)) return cached;
    const file = Bun.file(join(root, path));
    const found = (await file.exists())
      ? scanFixHelpers(maskLiterals(await file.text()))
      : undefined;
    modules.set(path, found);
    return found;
  };

  return async (path, source) => {
    const helpers: FixHelper[] = [];
    for (const declaration of scanImports(source)) {
      let declared: readonly FixHelper[] | undefined;
      for (const candidate of candidatePaths(path, declaration.specifier)) {
        declared = await helpersIn(candidate);
        if (declared !== undefined) break;
      }
      for (const name of declaration.names) {
        const helper = (declared ?? []).find((one) => one.name === name.exported);
        if (helper !== undefined) helpers.push({ name: name.local, index: helper.index });
      }
    }
    return helpers;
  };
}
