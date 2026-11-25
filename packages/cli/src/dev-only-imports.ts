// The specifiers no container role may evaluate, and the one edit that clears an app module of one.
// A leaf: the gate's check (`app-dev-imports.ts`) and the load's explanation of a failed import
// (`app-load-import-chain.ts`) read one rule, so a finding at boot and one at the gate agree.

import { quoteArg } from './shell-quote';

/**
 * `@ultimat3/cli`'s barrel is every command, template and the test harness, and it imports
 * `@ultimat3/testing`; a role's entry is `@ultimat3/cli/serve`. `bun:test` is the runner's own.
 */
export const isDevOnlySpecifier = (specifier: string): boolean =>
  specifier === '@ultimat3/cli' ||
  specifier === 'bun:test' ||
  /^@ultimat3\/testing(?:\/|$)/.test(specifier);

/** `apps/web/app/x.ts` → `apps/web/test/`: beside the surfaces, and outside every app-scan glob. */
const testHome = (at: string): string => {
  const workspace = /^(?:apps|packages)\/[^/]+(?=\/)/.exec(at)?.[0];
  return workspace === undefined ? 'a test/ directory' : `${workspace}/test/`;
};

/** The edit, opening with the line to look at. `at` is app-root-relative. */
export const devOnlyImportFix = (at: string, specifier: string): string =>
  `grep -nF -- ${quoteArg(specifier)} ${quoteArg(at)}   # test support moves to ${testHome(at)}, which no role loads; a module a role needs drops this import`;
