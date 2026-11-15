// Every module a test file can reach by import, read from source: what a shared worker uses to
// tell a file's OWN environment from the declarations an earlier file's imports left behind. Bun
// publishes no module graph (`require.cache` entries carry no `children` for ESM), so it is scanned.

/** The closure, and whether every module in it could be read: an incomplete one filters nothing. */
export interface ImportGraph {
  readonly modules: ReadonlySet<string>;
  readonly complete: boolean;
}

/** Only these are scanned; a `.json` or `.css` import is a leaf that declares nothing. */
const CODE = /\.[cm]?[jt]sx?$/;

/** `bin.ts` opens with a shebang, which the transpiler refuses as a syntax error. */
const withoutShebang = (source: string): string =>
  source.startsWith('#!') ? `//${source.slice(2)}` : source;

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
  js: new Bun.Transpiler({ loader: 'js' }),
  jsx: new Bun.Transpiler({ loader: 'jsx' }),
} as const;

const transpilerFor = (path: string): Bun.Transpiler => {
  if (path.endsWith('.tsx')) return transpilers.tsx;
  if (path.endsWith('.jsx')) return transpilers.jsx;
  if (/\.[cm]?ts$/.test(path)) return transpilers.ts;
  return transpilers.js;
};

const dirOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/';

/**
 * A module's direct imports, resolved, or `undefined` when its source could not be read. Third-
 * party code under `node_modules` is a leaf: it never declares an Ultimate permission, and walking
 * it would multiply the scan for nothing. A specifier that does not resolve statically (a template
 * `import()`, a plugin's virtual module) is skipped — the caller keeps anything first declared
 * during the file, so a module reached that way is not lost on its first evaluation.
 */
async function directImports(path: string): Promise<readonly string[] | undefined> {
  if (!CODE.test(path) || path.endsWith('.d.ts') || path.includes('/node_modules/')) return [];
  let source: string;
  try {
    source = await Bun.file(path).text();
  } catch {
    return undefined;
  }
  let specifiers: readonly string[];
  try {
    specifiers = transpilerFor(path)
      .scanImports(withoutShebang(source))
      .map((entry) => entry.path);
  } catch {
    return undefined;
  }
  const dir = dirOf(path);
  const resolved: string[] = [];
  for (const specifier of specifiers) {
    if (specifier.startsWith('bun:') || specifier.startsWith('node:')) continue;
    try {
      resolved.push(Bun.resolveSync(specifier, dir));
    } catch {
      // Unresolvable statically: see the doc comment.
    }
  }
  return resolved;
}

/** One reader per process: a module's imports are read once however many files reach it. */
export function importGraphReader(): (entry: string) => Promise<ImportGraph> {
  const direct = new Map<string, Promise<readonly string[] | undefined>>();
  const importsOf = (path: string): Promise<readonly string[] | undefined> => {
    let pending = direct.get(path);
    if (pending === undefined) {
      pending = directImports(path);
      direct.set(path, pending);
    }
    return pending;
  };
  return async (entry) => {
    const modules = new Set<string>([entry]);
    let complete = true;
    let frontier = [entry];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const imports of await Promise.all(frontier.map(importsOf))) {
        if (imports === undefined) {
          complete = false;
          continue;
        }
        for (const module of imports) {
          if (modules.has(module)) continue;
          modules.add(module);
          next.push(module);
        }
      }
      frontier = next;
    }
    return { modules, complete };
  };
}
