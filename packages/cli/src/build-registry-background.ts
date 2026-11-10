// Which of the app's modules a background role (`worker`, `scheduler`) imports, decided at image
// build time for the prebuilt registry: the same rule `scanBackground` applies module by module at
// boot (`role-load.ts`), with what the process has "already loaded" simulated from the static
// import graph instead of read from Bun's module cache — so the boot imports a list, not a walk.

// why: Bun ships no path API; the API index is named app-root-relative and compared absolute.
import { resolve } from 'node:path';
import { API_INDEX } from './app-root';
import { createDocumentGraph } from './document-graph';
import { resolvedImports } from './module-imports';
import { hasPathSegment } from './path-segments';

/** An installed framework package — walked, as the document graph walks it. */
const FRAMEWORK_SCOPE = '/node_modules/@ultimat3/';

/** The files evaluating `path` evaluates, by the document graph's own rule for what it follows. */
async function evaluatedImports(path: string): Promise<readonly string[]> {
  const source = await Bun.file(path)
    .text()
    .catch(() => '');
  return resolvedImports(path, source, 'evaluated').filter(
    (target) => !hasPathSegment(target, 'node_modules') || target.includes(FRAMEWORK_SCOPE),
  );
}

/**
 * The subset of `modules` (absolute, scan order) a background role imports, in the same order:
 * the API index, every module an earlier imported one already evaluated, and every module that
 * reaches no document. "Already evaluated" is the static closure of what was imported before it —
 * the runtime answer differs only by a top-level `await import()`, which makes the runtime import
 * MORE; a job that leaves out is answered at boot by the manifest check (`X_ROLE_LOAD_INCOMPLETE`).
 */
export async function backgroundModules(
  root: string,
  modules: readonly string[],
): Promise<readonly string[]> {
  const index = resolve(root, API_INDEX);
  const evaluated = new Set<string>();
  const graph = createDocumentGraph((absolute) => evaluated.has(absolute));
  const evaluate = async (start: string): Promise<void> => {
    const stack = [start];
    while (stack.length > 0) {
      const path = stack.pop();
      if (path === undefined || evaluated.has(path)) continue;
      evaluated.add(path);
      stack.push(...(await evaluatedImports(path)));
    }
  };
  const included: string[] = [];
  for (const absolute of modules) {
    // `evaluated.has` first only skips a walk: the graph's own oracle answers it the same way.
    const take =
      absolute === index || evaluated.has(absolute) || !(await graph.reachesDocument(absolute));
    if (!take) continue;
    included.push(absolute);
    await evaluate(absolute);
  }
  return included;
}
