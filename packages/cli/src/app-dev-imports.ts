// `X_BOUNDARY_DEV_IMPORT`: what the boot scan imports reaches no development entry. A test helper
// under `app/` is an app module, and one brought `@ultimat3/cli`'s barrel into every role, the gate
// green. A WARNING on `main` (X_BREAKING_ON_MAIN); the refusal lands on `next`.

// why: Bun ships no path API; the marker of an app root is read at a joined path.
import { join, resolve } from 'node:path';
import { APP_CONFIG_FILE, ERROR_DOCS_URL } from '@ultimat3/core';
import { scannedModulePaths } from './app-load';
import { realPath } from './app-load-unresolved';
import { devOnlyImportFix, isDevOnlySpecifier } from './dev-only-imports';
import type { ChainStep, EvaluatedImport, WalkVerdict } from './evaluated-walk';
import { createEvaluatedGraph } from './evaluated-walk';
import type { Finding } from './output';
import { hasPathSegment, isPathUnder } from './path-segments';
import { posixRelative } from './posix-path';
import { quoteArg } from './shell-quote';

/**
 * The line to edit. The offender itself when the scan imports it; when it sits outside the scan (a
 * kit under `test/`), moving it clears nothing and the cut is the scanned module's edge towards it.
 */
function fixFor(
  steps: readonly ChainStep[],
  specifier: string,
  scanned: ReadonlySet<string>,
  named: (path: string) => string,
): string {
  const last = steps.findLastIndex((step) => scanned.has(step.path));
  const into = steps[last + 1]?.specifier;
  const from = named(steps[last]?.path ?? '');
  if (into === undefined) return devOnlyImportFix(from, specifier);
  return `grep -nF -- ${quoteArg(into)} ${quoteArg(from)}   # it brings test support into a module a role loads: only a test imports that`;
}

/** One finding per development import the app's boot evaluates, in path order. */
export async function devImportFindings(root: string): Promise<readonly Finding[]> {
  // An app only: the framework monorepo has no boot scan, and its `packages/cli` IS the barrel.
  if (!(await Bun.file(join(root, APP_CONFIG_FILE)).exists())) return [];
  const base = realPath(resolve(root));
  const starts = (await scannedModulePaths(base)).map(realPath);
  const named = (path: string): string => posixRelative(base, path);
  const found: EvaluatedImport[] = [];
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
    return own ? 'follow' : 'skip';
  };
  const walk = await createEvaluatedGraph().walk(starts, judge);
  const scanned = new Set(starts);
  const findings = found.map(({ from, specifier }): Finding => {
    const steps = walk.chainTo(from);
    const chain = steps.map((step) => named(step.path));
    const via = chain.length === 1 ? '' : ` (${chain.join(' → ')})`;
    return {
      code: 'X_BOUNDARY_DEV_IMPORT',
      cause: `the boot scan imports ${named(from)}${via}, and it imports "${specifier}", a development entry: an image that leaves the test packages out boots no role`,
      fix: fixFor(steps, specifier, scanned, named),
      docs: ERROR_DOCS_URL,
      at: named(from),
      meta: { specifier, chain },
    };
  });
  const key = (finding: Finding): string => `${finding.at ?? ''}\u0000${finding.cause}`;
  return findings.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** What the `boundaries` step carries on `main`: one line per finding, advice and never red. */
export async function devImportWarnings(root: string): Promise<readonly string[]> {
  return (await devImportFindings(root)).map(
    (finding) => `${finding.code} ${finding.cause} — fix: ${finding.fix}`,
  );
}
