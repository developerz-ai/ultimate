// `X_BOUNDARY_DEV_IMPORT`: what the boot scan imports reaches no development entry. A test helper
// under `app/` is an app module, and one brought `@ultimat3/cli`'s barrel into every role, the gate
// green. A WARNING on `main` (X_BREAKING_ON_MAIN); the refusal lands on `next`.

// why: Bun ships no path API; the marker of an app root is read at a joined path.
import { join, resolve } from 'node:path';
import { APP_CONFIG_FILE, ERROR_DOCS_URL } from '@ultimat3/core';
import { realPath } from './app-load-unresolved';
import { devOnlyCut, devOnlyFix, isDevOnlySpecifier, scannedModules } from './dev-only-imports';
import type { ChainStep, EvaluatedImport, WalkVerdict } from './evaluated-walk';
import { createEvaluatedGraph } from './evaluated-walk';
import type { Finding } from './output';
import { hasPathSegment, isPathUnder } from './path-segments';
import { posixRelative } from './posix-path';

/** Followed edges, by the module they lead to. */
type EdgesInto = ReadonlyMap<string, readonly EvaluatedImport[]>;

/**
 * Every way the scan has into `holder`: itself when it is scanned, else one chain per scanned edge
 * towards it through modules outside the scan. Each edge is its own cut — one shared kit under
 * `test/` is loaded until the last scanned module importing it stops.
 */
function waysInto(
  holder: string,
  scanned: ReadonlySet<string>,
  into: EdgesInto,
): readonly (readonly ChainStep[])[] {
  if (scanned.has(holder)) return [[{ path: holder }]];
  const ways: ChainStep[][] = [];
  /** The edge each module outside the scan takes towards the holder. */
  const towards = new Map<string, EvaluatedImport | undefined>([[holder, undefined]]);
  for (const [path] of towards) {
    for (const edge of into.get(path) ?? []) {
      if (!scanned.has(edge.from)) {
        if (!towards.has(edge.from)) towards.set(edge.from, edge);
        continue;
      }
      const way: ChainStep[] = [{ path: edge.from }, { path, specifier: edge.specifier }];
      for (let next = towards.get(path); next !== undefined; ) {
        const target = next.target() ?? holder;
        way.push({ path: target, specifier: next.specifier });
        next = towards.get(target);
      }
      ways.push(way);
    }
  }
  return ways;
}

/** One finding per cut the app owes a development import its boot evaluates, in path order. */
export async function devImportFindings(root: string): Promise<readonly Finding[]> {
  // An app only: the framework monorepo has no boot scan, and its `packages/cli` IS the barrel.
  if (!(await Bun.file(join(root, APP_CONFIG_FILE)).exists())) return [];
  const base = realPath(resolve(root));
  const scanned = await scannedModules(base);
  const named = (path: string): string => posixRelative(base, path);
  const found: EvaluatedImport[] = [];
  const into = new Map<string, EvaluatedImport[]>();
  const judge = (edge: EvaluatedImport): WalkVerdict => {
    if (isDevOnlySpecifier(edge.specifier)) {
      found.push(edge);
      return 'skip';
    }
    // The app's own modules only: an installed package answers for its own graph.
    const target = edge.target();
    const own =
      target !== undefined &&
      isPathUnder(base, target) &&
      !hasPathSegment(named(target), 'node_modules');
    if (!own) return 'skip';
    const edges = into.get(target);
    if (edges === undefined) into.set(target, [edge]);
    else edges.push(edge);
    return 'follow';
  };
  await createEvaluatedGraph().walk([...scanned], judge);
  const findings = new Map<string, Finding>();
  for (const { from, specifier } of found) {
    for (const steps of waysInto(from, scanned, into)) {
      const cut = devOnlyCut(steps, scanned);
      const chain = steps.map((step) => named(step.path));
      const at = chain[cut.index] ?? named(from);
      const via = chain.length === 1 ? '' : ` (${chain.join(' → ')})`;
      const finding: Finding = {
        code: 'X_BOUNDARY_DEV_IMPORT',
        cause: `the boot scan imports ${named(from)}${via}, and it imports "${specifier}", a development entry: an image that leaves the test packages out boots no role`,
        fix: devOnlyFix(at, cut, specifier),
        docs: ERROR_DOCS_URL,
        at,
        meta: { specifier, chain },
      };
      // One import written twice in a module is one edit: the same line finds both.
      findings.set(
        [at, chain.join('\u0000'), specifier, finding.fix].join('\u0000\u0000'),
        finding,
      );
    }
  }
  return [...findings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, one]) => one);
}

/** What the `boundaries` step carries on `main`: one line per finding, advice and never red. */
export async function devImportWarnings(root: string): Promise<readonly string[]> {
  return (await devImportFindings(root)).map(
    (finding) => `${finding.code} ${finding.cause} — fix: ${finding.fix}`,
  );
}
