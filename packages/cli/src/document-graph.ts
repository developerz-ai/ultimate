// Whether importing an app module would bring a DOCUMENT module into this process: a component
// (`.tsx`) or a stylesheet. A role that renders nothing asks this before each import
// (`role-load.ts`), so a worker never compiles the app's Sass or evaluates its pages to learn that
// they register no job.

import { resolvedImports } from './module-imports';
import { hasPathSegment } from './path-segments';

/** A component or a stylesheet: what only a process that renders documents evaluates. */
const DOCUMENT = /\.(?:[jt]sx|s[ac]ss|css)$/;

export const isDocumentModule = (path: string): boolean => DOCUMENT.test(path);

/** An installed framework package, under either linker: `…/node_modules/@ultimat3/<pkg>/…`. */
const FRAMEWORK_SCOPE = '/node_modules/@ultimat3/';

export interface DocumentGraph {
  /**
   * True when importing `absolute` would evaluate a document module this process has not already
   * loaded. Errs toward `false`: a specifier that will not resolve and a file that will not parse
   * contribute no edge, so the caller imports the module and the import itself reports the fault.
   */
  reachesDocument(absolute: string): Promise<boolean>;
}

/**
 * `loaded` answers whether a module is already in this process — a module the API index imported
 * costs nothing more, whatever it reaches, so the walk stops there. Injected, so a test decides it.
 */
export function createDocumentGraph(loaded: (absolute: string) => boolean): DocumentGraph {
  const edges = new Map<string, readonly string[]>();
  const verdicts = new Map<string, boolean>();

  /**
   * The files importing `path` evaluates, when the walk follows them: the app's own modules and
   * the framework's — `@ultimat3/ui` is a barrel of components, and an app module importing it
   * brings every one of them and their Sass. A third-party package is not walked: it ships no
   * component this framework's loader compiles. A lazy import's target is no edge at all.
   */
  async function importsOf(path: string): Promise<readonly string[]> {
    const known = edges.get(path);
    if (known !== undefined) return known;
    // Unreadable: no edge, and the caller's own import is what reports it.
    const source = await Bun.file(path)
      .text()
      .catch(() => '');
    const found = resolvedImports(path, source, 'evaluated').filter(
      (target) => !hasPathSegment(target, 'node_modules') || target.includes(FRAMEWORK_SCOPE),
    );
    edges.set(path, found);
    return found;
  }

  return {
    async reachesDocument(absolute: string): Promise<boolean> {
      const known = verdicts.get(absolute);
      if (known !== undefined) return known;
      // The whole reachable set, never a per-node recursion: inside an import cycle a node's own
      // answer depends on one still being computed, and a `false` memoised there is wrong.
      const seen = new Set<string>();
      const stack = [absolute];
      let reaches = false;
      while (stack.length > 0 && !reaches) {
        const path = stack.pop();
        if (path === undefined || seen.has(path)) continue;
        seen.add(path);
        if (verdicts.get(path) === true || (isDocumentModule(path) && !loaded(path))) {
          reaches = true;
          break;
        }
        // Already here, or already cleared: nothing below it is new to this process.
        if (isDocumentModule(path) || loaded(path) || verdicts.get(path) === false) continue;
        stack.push(...(await importsOf(path)));
      }
      // A clean walk clears everything it visited — each one's reachable set is inside this one's.
      // A walk that found a document proves it for the start alone.
      if (reaches) verdicts.set(absolute, true);
      else for (const path of seen) verdicts.set(path, false);
      return reaches;
    },
  };
}
