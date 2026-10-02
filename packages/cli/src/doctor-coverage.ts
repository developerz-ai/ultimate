// `x doctor`'s coverage listing: every file the app's coverage floor does not see, and the reason
// `x.verify.json` gives for each. A LISTING, never a finding: an `exclude` with its `why` is a
// decision the app made in a committed file — printing it is what keeps the decision in view, and
// a red `x doctor` over it would be the framework overruling what it asked to be written down.

import type { CoverageExclude } from './coverage-floor';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { readVerifyFloor } from './verify-floor';

/** The I/O half: the excludes this app's `x.verify.json` states. None when it states no floor. */
export async function coverageExcludesProbe(root: string): Promise<readonly CoverageExclude[]> {
  return (await readVerifyFloor(root))?.coverage?.exclude ?? [];
}

/**
 * The listing, on a result `x doctor` already decided: `data.coverage.exclude` for a machine, one
 * line per entry for a person. `ok`, the summary and the findings are returned as they came.
 */
export function withCoverageExcludes(
  result: CommandResult,
  exclude: readonly CoverageExclude[],
): CommandResult {
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const listed: JsonValue = exclude.map(({ glob, why }) => ({ glob, why }));
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), coverage: { exclude: listed } },
    ...(exclude.length === 0
      ? {}
      : {
          lines: [
            ...(result.lines ?? []),
            msg('cli.doctor.coverageExclude', { count: exclude.length }),
            ...exclude.map(({ glob, why }) => `  ${glob} — ${why}`),
          ],
        }),
  };
}
