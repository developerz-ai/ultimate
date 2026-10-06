// What a module bundled twice costs the build. A framework bug refuses it: one file under two
// spellings, or a second `@ultimat3/*` copy, is the framework's resolver or dedupe failing. A
// third-party package installed twice with identical bytes is the app's lockfile, which the app
// did not write by hand — so it is a warning naming the bytes, never a broken build.

import { logger, UltimateError } from '@ultimat3/core';
import type { DuplicatedModule, IslandMetafile, ModuleIdentityIo } from './island-duplicates';
import { duplicatedModules, hostIo } from './island-duplicates';
import { quoteArg } from './shell-quote';

/** The framework's own scope: a second copy of one of these is ours to fold (`island-package-dedupe.ts`). */
const FRAMEWORK_SCOPE = '@ultimat3/';

/** A duplicate only the framework can have caused. */
export const isFrameworkDuplicate = (one: DuplicatedModule): boolean =>
  one.sameFile || (one.packageName?.startsWith(FRAMEWORK_SCOPE) ?? false);

/**
 * Its own code, not `X_BUILD_FAILED`: that one's fix re-runs `bun build`, which SUCCEEDS here — the
 * build did not fail, it shipped one module twice and said `success: true`. Every refusal is a
 * framework defect, so the fix is the report that gets it fixed.
 */
export class IslandModuleDuplicatedError extends UltimateError {
  constructor(island: string, found: readonly DuplicatedModule[]) {
    const wasted = found.reduce((sum, one) => sum + one.wastedBytes, 0);
    const listed = found
      .slice(0, 3)
      .map((one) => `${one.package ?? 'one file'} as ${one.spellings.join(' and ')}`)
      .join('; ');
    super({
      code: 'X_ISLAND_MODULE_DUPLICATED',
      cause:
        `${island} bundles ${found.length} module(s) more than once in ${found[0]?.output ?? 'its chunk'} ` +
        `(${wasted} B shipped twice): ${listed}${found.length > 3 ? `; and ${found.length - 3} more` : ''}`,
      fix: `gh issue create --repo developerz-ai/ultimate --title ${quoteArg(`X_ISLAND_MODULE_DUPLICATED in ${island}`)} — paste this error's --json as the body: the framework bundled one of its own modules twice`,
    });
  }
}

/** The one line a third-party copy costs: the island, the package, the bytes, and what to run. */
export const thirdPartyWarning = (island: string, one: DuplicatedModule): string =>
  `X_ISLAND_MODULE_DUPLICATED (warning): ${island} bundles ${one.package ?? 'a package'} twice ` +
  `(${one.wastedBytes} B shipped twice, as ${one.spellings.join(' and ')}) — fix: bun why ` +
  `${quoteArg(one.packageName ?? '<package>')}, then bun install --force to fold the copies`;

/** Refuse a framework duplicate; warn about each third-party one. */
export async function refuseDuplicatedModules(
  island: string,
  metafile: IslandMetafile,
  io: ModuleIdentityIo = hostIo(),
  warn: (line: string) => void = (line) => logger.warn(line),
): Promise<void> {
  const found = await duplicatedModules(metafile, io);
  const fatal = found.filter(isFrameworkDuplicate);
  if (fatal.length > 0) throw new IslandModuleDuplicatedError(island, fatal);
  for (const one of found) warn(thirdPartyWarning(island, one));
}
