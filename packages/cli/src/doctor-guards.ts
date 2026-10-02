// `x doctor`'s guard listing: the guards the framework ships that this app's `guards/` does not
// hold, each with the command that adds it. A LISTING, never a finding: every shipped guard says
// "delete this file to drop the rule", so an app without one may have decided — and a red
// `x doctor` over a decision would be the framework overruling the convention it handed over.

import { GUARD_DIR, guardPaths } from './guards';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { SHIPPED_GUARD_NAMES } from './templates/scaffold-guards';

export interface MissingGuard {
  readonly name: string;
  /** The command that writes it, with its test. Then `x verify` says what it finds. */
  readonly add: string;
}

/** The rule, pure: which shipped names have no file among the guards an app holds. */
export function missingShippedGuards(present: readonly string[]): readonly MissingGuard[] {
  const held = new Set(present.map((path) => path.replace(/\.tsx?$/, '')));
  return SHIPPED_GUARD_NAMES.filter((name) => !held.has(`${GUARD_DIR}/${name}`)).map((name) => ({
    name,
    add: `x g guard ${name}`,
  }));
}

/** The I/O half: the same enumeration the `boundaries` step runs, so the two cannot disagree. */
export async function shippedGuardsProbe(root: string): Promise<readonly MissingGuard[]> {
  return missingShippedGuards(await guardPaths(root));
}

/**
 * The listing, on a result `x doctor` already decided: `data.guards.missing` for a machine, one
 * line per command for a person. `ok`, the summary and the findings are returned as they came.
 */
export function withGuardListing(
  result: CommandResult,
  missing: readonly MissingGuard[],
): CommandResult {
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const listed: JsonValue = missing.map(({ name, add }) => ({ name, add }));
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), guards: { missing: listed } },
    ...(missing.length === 0
      ? {}
      : {
          lines: [
            ...(result.lines ?? []),
            msg('cli.doctor.guards', { count: missing.length }),
            ...missing.map(({ add }) => `  ${add}`),
          ],
        }),
  };
}
