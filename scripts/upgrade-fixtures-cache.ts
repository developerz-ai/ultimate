// The caches several `upgrade-fixtures` runs share: the scaffold cache, where the first run to
// finish an `x new` wins and every other uses its copy, and Bun's install cache, where a run
// removes only the loopback-registry entries that appeared while it ran — never another run's.

// why: Bun has no directory listing, rename or recursive remove.
import { readdirSync, renameSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { quoteArg } from '../packages/cli/src/shell-quote';
import { ScriptError } from './lib/script-error';
import { SCOPE } from './upgrade-fixtures-packument';

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

/**
 * Moves `from` to `to` and answers `to`. When another run's rename landed first (`ENOTEMPTY`,
 * `EEXIST`, `EPERM` on Windows), its copy is the one used and `from` is dropped.
 */
export function adoptInto(from: string, to: string): string {
  try {
    renameSync(from, to);
  } catch (error) {
    const code = String(codeOf(error));
    if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(code)) {
      throw new ScriptError({
        code: 'X_UPGRADE_FIXTURE_UNBUILT',
        cause: `the scaffold could not be moved into the cache at ${to} (${code})`,
        fix: `ls -ld ${quoteArg(join(to, '..'))}`,
      });
    }
    rmSync(from, { recursive: true, force: true });
  }
  return to;
}

/** The scope's install-cache entries a loopback registry wrote, sorted. */
export function loopbackEntries(installCache: string): readonly string[] {
  try {
    return readdirSync(join(installCache, SCOPE))
      .filter((entry) => entry.includes('@@127.0.0.1__'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Removes the loopback entries not in `before` — the ones this run's servers caused — and answers
 * them. Bun keys an entry on a hash of the registry URL, which this script cannot recompute, so the
 * snapshot taken before the first server started is what tells this run's entries apart.
 */
export function purgeLoopbackEntries(
  installCache: string,
  before: ReadonlySet<string>,
): readonly string[] {
  const mine = loopbackEntries(installCache).filter((entry) => !before.has(entry));
  for (const entry of mine) {
    rmSync(join(installCache, SCOPE, entry), { recursive: true, force: true });
  }
  return mine;
}
