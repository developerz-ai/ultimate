// The ratchet under `scripts/log-levels.ts`: how many `info` lines each package writes on a
// per-unit path (`PER_UNIT_FILES`) without a `// info: <why>` saying why the event is news. A count
// may FALL and never rise. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/log-levels.ts --unpin <pkg>[,<pkg>]`.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const LOG_LEVEL_PINS_FILE = 'scripts/lib/log-levels-pins.ts';

export interface LogLevelPin {
  readonly count: number;
  /** Which events these are and why each is lifecycle or a rare outcome — never "it is fine". */
  readonly reason: string;
}

/**
 * Measured 2026-11-13, when the guard landed. Every row is a site that already obeys the policy
 * (lifecycle, or a rare outcome) and owes only its inline `// info:` — written by the package's
 * owner, then `--unpin`. The two marked `review:` are per-unit successes a later slice may demote.
 */
export const LOG_LEVEL_PINS: Readonly<Record<string, LogLevelPin>> = {};
