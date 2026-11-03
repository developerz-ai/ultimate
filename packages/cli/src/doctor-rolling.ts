// `x doctor`'s reminder: an app with no `rollingSince` is not judged by the rolling rail, and one
// line says which id turns it on. A REMINDER, never a finding: the rail is off because an applied
// migration cannot gain a marker, and a red `x doctor` over that would be a failure nobody can clear.

import { msg } from './messages';
import { readMigrations } from './migrations';
import type { CommandResult, JsonValue } from './output';
import { readVerifyFloor } from './verify-floor';

export interface RollingReminder {
  /** The newest migration id: what `rollingSince` is set to, judging only what comes after. */
  readonly newest: string;
}

/** The I/O half. `undefined` when the rail is on, or when an app has no migration to name. */
export async function rollingSinceProbe(root: string): Promise<RollingReminder | undefined> {
  if ((await readVerifyFloor(root))?.rollingSince !== undefined) return undefined;
  const newest = (await readMigrations(root)).at(-1)?.id;
  return newest === undefined ? undefined : { newest };
}

/** The line, on a result `x doctor` already decided: `ok` and the findings stay as they came. */
export function withRollingReminder(
  result: CommandResult,
  reminder: RollingReminder | undefined,
): CommandResult {
  if (reminder === undefined) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const rolling: JsonValue = { unset: true, newest: reminder.newest };
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), rolling },
    lines: [...(result.lines ?? []), msg('cli.doctor.rollingSince', { newest: reminder.newest })],
  };
}
