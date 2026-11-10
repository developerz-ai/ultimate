// Which app modules evaluate ASYNCHRONOUSLY — a top-level `await` in the module or in anything of
// the app's it imports. In one entry module such a module suspends and its later siblings run
// meanwhile, so the batched import (`app-load-batch.ts`) imports each on its own: the serial
// scan's evaluation order is the guarantee, and these are the modules that would break it.

// why: Bun ships no path API; the walk resolves imports to absolute paths and names them back.
import { basename, resolve } from 'node:path';
import { resolvedImports } from './module-imports';
import { hasPathSegment, isPathUnder } from './path-segments';
import { isTest } from './source-files';

/** Every source the app could import: the scan's globs are not the whole of what modules import. */
const APP_SOURCE = '**/*.{ts,tsx,mts,js,jsx,mjs}';

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
  js: new Bun.Transpiler({ loader: 'js' }),
};

/**
 * The module statements, removed or turned into the declarations they export, so what remains
 * is a statement list a class static block can hold. Read off Bun's own printed output, whose
 * shape is fixed: one statement per `import`/`export`, double-quoted specifiers.
 */
function withoutModuleSyntax(printed: string): string {
  return printed
    .replace(/^import\s[\s\S]*?\sfrom\s*"[^"]*";/gm, '')
    .replace(/^import\s*"[^"]*";/gm, '')
    .replace(/^export\s*\*[^;]*;/gm, '')
    .replace(/^export\s*\{[\s\S]*?\}(?:\s*from\s*"[^"]*")?;/gm, '')
    .replace(/^export\s+default\s+/gm, 'void ')
    .replace(/^export\s+/gm, '')
    .replace(/\bimport\.meta\b/g, '({})');
}

/**
 * Whether `source` awaits at its top level. Parsed, never pattern-matched: the statements go into a
 * class static block, where `await` is reserved — `await x`, `await (x)` and `for await` refuse
 * there exactly as they run at a module's top level, while every `await` inside an async function
 * still parses. A source the parser refuses for any other reason is answered `true`: importing it
 * alone costs a little speed, importing it in a batch could cost the order.
 */
export function hasTopLevelAwait(path: string, source: string): boolean {
  if (!source.includes('await')) return false;
  const loader = /x$/.test(path) ? transpilers.tsx : transpilers.ts;
  try {
    const statements = withoutModuleSyntax(loader.transformSync(source));
    transpilers.js.transformSync(`class __XTopLevel { static {\n${statements}\n} }`);
    return false;
  } catch {
    return true;
  }
}

const inApp = (root: string, path: string): boolean =>
  isPathUnder(root, path) && !hasPathSegment(path, 'node_modules');

/** Every app source, read, and the ones that await at their top level. */
async function readSources(root: string): Promise<{
  readonly sources: ReadonlyMap<string, string>;
  readonly awaiting: readonly string[];
}> {
  const sources = new Map<string, string>();
  const awaiting: string[] = [];
  const paths: string[] = [];
  for await (const path of new Bun.Glob(APP_SOURCE).scan({ cwd: root, absolute: true })) {
    // A test is imported by no module: `bun test` loads it, never the scan.
    if (!hasPathSegment(path, 'node_modules') && !isTest(path)) paths.push(path);
  }
  // Bounded: an app of 12k files opened 12k descriptors at once otherwise.
  for (let start = 0; start < paths.length; start += 64) {
    const batch = paths.slice(start, start + 64);
    const texts = await Promise.all(batch.map((path) => Bun.file(path).text()));
    for (const [index, path] of batch.entries()) {
      const text = texts[index] as string;
      sources.set(path, text);
      if (hasTopLevelAwait(path, text)) awaiting.push(path);
    }
  }
  return { sources, awaiting };
}

/**
 * Whether any source could import `path`: a specifier ending in its file name, with or without the
 * extension. A filter, never the answer — it only spares the import walk for the awaiting modules
 * nothing names, which are most of them: `server.ts`, `prerender.ts`, `bin/` scripts.
 */
function named(path: string, sources: ReadonlyMap<string, string>): boolean {
  const file = basename(path);
  const stem = file.replace(/\.[cm]?[jt]sx?$/, '');
  const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const specifier = new RegExp(`[/'"](?:${escaped(stem)}|${escaped(file)})['"]`);
  for (const [other, text] of sources) {
    if (other !== path && specifier.test(text)) return true;
  }
  return false;
}

/**
 * The modules of `modules` (absolute) whose evaluation can suspend: one that awaits at its top
 * level, or reaches one through the app's own imports. The framework and `node_modules` are not
 * walked — the CLI has evaluated the framework before any scan, so it is no longer async. The
 * common answer, no importable top-level await in the app, costs one read of each source.
 */
export async function asyncModules(
  root: string,
  modules: readonly string[],
): Promise<ReadonlySet<string>> {
  const base = resolve(root);
  const { sources, awaiting } = await readSources(base);
  // The common answer: nothing the app could import awaits at its top level, and no walk runs.
  if (!awaiting.some((path) => modules.includes(path) || named(path, sources))) return new Set();
  const answered = new Map<string, boolean>();
  const reaches = (path: string, visiting: Set<string>): boolean => {
    const known = answered.get(path);
    if (known !== undefined) return known;
    // A cycle is answered by the rest of the walk: the module on the stack is still deciding.
    if (visiting.has(path)) return false;
    visiting.add(path);
    const source = sources.get(path);
    const awaits =
      source !== undefined &&
      (hasTopLevelAwait(path, source) ||
        resolvedImports(path, source, 'evaluated')
          .filter((target) => inApp(base, target))
          .some((target) => reaches(target, visiting)));
    visiting.delete(path);
    answered.set(path, awaits);
    return awaits;
  };
  return new Set(modules.filter((path) => reaches(path, new Set())));
}
