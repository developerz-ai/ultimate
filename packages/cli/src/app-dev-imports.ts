// `X_BOUNDARY_DEV_IMPORT`: what the boot scan imports reaches no development entry. A test helper
// under `app/` is an app module, and one brought `@ultimat3/cli`'s barrel into every role, the gate
// green. A WARNING on `main` (X_BREAKING_ON_MAIN); the refusal lands on `next`.

// why: Bun ships no path API; the marker of an app root is read at a joined path.
import { join, resolve } from 'node:path';
import { APP_CONFIG_FILE, ERROR_DOCS_URL } from '@ultimat3/core';
import { realPath } from './app-load-unresolved';
import { devOnlyCut, devOnlyFix, isDevOnlySpecifier, scannedModules } from './dev-only-imports';
import type { EvaluatedImport, WalkVerdict } from './evaluated-walk';
import { createEvaluatedGraph } from './evaluated-walk';
import type { Finding } from './output';
import { hasPathSegment, isPathUnder } from './path-segments';
import { posixRelative } from './posix-path';
import { scanWays } from './scan-ways';

/** One finding per cut the app owes a development import its boot evaluates, in path order. */
export async function devImportFindings(root: string): Promise<readonly Finding[]> {
  // An app only: the framework monorepo has no boot scan, and its `packages/cli` IS the barrel.
  if (!(await Bun.file(join(root, APP_CONFIG_FILE)).exists())) return [];
  const base = realPath(resolve(root));
  const scanned = await scannedModules(base);
  const named = (path: string): string => posixRelative(base, path);
  const found: EvaluatedImport[] = [];
  const followed: EvaluatedImport[] = [];
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
    followed.push(edge);
    return 'follow';
  };
  await createEvaluatedGraph().walk([...scanned], judge);
  const ways = scanWays(
    found.map((edge) => edge.from),
    scanned,
    followed,
  );
  const findings = new Map<string, Finding>();
  for (const { from, specifier } of found) {
    for (const steps of ways(from)) {
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
