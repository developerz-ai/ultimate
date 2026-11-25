// The specifiers no container role may evaluate, and the one edit that clears an app of one: where
// on the way from a scanned module to the import the cut is, and the line to run there. The gate's
// check (`app-dev-imports.ts`) and the load's explanation of a failed import
// (`app-load-import-chain.ts`) read one rule, so a finding at boot and one at the gate agree.

import { scannedModulePaths } from './app-load';
import { realPath } from './app-load-unresolved';
import { commentSafe } from './comment-safe';
import type { ChainStep } from './evaluated-walk';
import { quoteArg } from './shell-quote';

/**
 * `@ultimat3/cli`'s barrel is every command, template and the test harness, and it imports
 * `@ultimat3/testing`; a role's entry is `@ultimat3/cli/serve`. `bun:test` is the runner's own.
 */
export const isDevOnlySpecifier = (specifier: string): boolean =>
  specifier === '@ultimat3/cli' ||
  specifier === 'bun:test' ||
  /^@ultimat3\/testing(?:\/|$)/.test(specifier);

/** Every module the boot scan imports under `base`, links followed: what a cut may be made in. */
export const scannedModules = async (base: string): Promise<ReadonlySet<string>> =>
  new Set((await scannedModulePaths(base)).map(realPath));

/** `apps/web/app/x.ts` → `apps/web/test/`: beside the surfaces, and outside every app-scan glob. */
const testHome = (at: string): string => {
  const workspace = /^(?:apps|packages)\/[^/]+(?=\/)/.exec(at)?.[0];
  return workspace === undefined ? 'a test/ directory' : `${workspace}/test/`;
};

/** Where the cut is, and the import to look for there. */
export interface DevOnlyCut {
  /** Its index in the steps: the last module the boot scan imports. */
  readonly index: number;
  /** What that module imports on the way; `undefined` when it holds the development import itself. */
  readonly into: string | undefined;
}

/**
 * The cut on the way to a development import, whose holder is the last of `steps`. The holder when
 * the scan imports it; when it sits outside the scan (a kit under `test/`), moving it clears nothing
 * and the cut is the scanned module's edge towards it.
 */
export function devOnlyCut(steps: readonly ChainStep[], scanned: ReadonlySet<string>): DevOnlyCut {
  const index = Math.max(
    0,
    steps.findLastIndex((step) => scanned.has(step.path)),
  );
  return { index, into: steps[index + 1]?.specifier };
}

/** The edit, opening with the line to look at. `at` is app-root-relative: the cut's module. */
export function devOnlyFix(at: string, cut: DevOnlyCut, specifier: string): string {
  const line = `grep -nF -- ${quoteArg(cut.into ?? specifier)} ${quoteArg(at)}`;
  // `commentSafe`: a workspace directory's name is the repository's, and a newline ends a comment.
  return cut.into === undefined
    ? `${line}   # test support moves to ${commentSafe(testHome(at))}, which no role loads; a module a role needs drops this import`
    : `${line}   # it brings test support into a module a role loads: only a test imports that`;
}
