// Single responsibility: the autovacuum half of a `tableStorage()` declaration — the four trigger
// parameters a small, hot framework table states instead of Postgres' defaults (50 rows plus 20% of
// the table, more dead rows than such a table holds live ones), validated, rendered and read back.

/** When autovacuum visits a table, in Postgres' own terms. Each left out is not this value's. */
export interface TableAutovacuum {
  /** `autovacuum_vacuum_threshold`: dead rows before a vacuum, before the scale factor. */
  readonly vacuumThreshold?: number;
  /** `autovacuum_vacuum_scale_factor`: the fraction of the table added to the threshold. */
  readonly vacuumScaleFactor?: number;
  /** `autovacuum_analyze_threshold`. */
  readonly analyzeThreshold?: number;
  /** `autovacuum_analyze_scale_factor`. */
  readonly analyzeScaleFactor?: number;
}

/** Declaration key → storage parameter, in the order every rendering uses. */
const PARAMETERS = {
  vacuumThreshold: 'autovacuum_vacuum_threshold',
  vacuumScaleFactor: 'autovacuum_vacuum_scale_factor',
  analyzeThreshold: 'autovacuum_analyze_threshold',
  analyzeScaleFactor: 'autovacuum_analyze_scale_factor',
} as const;

export type AutovacuumParameter = (typeof PARAMETERS)[keyof typeof PARAMETERS];

const INT4_MAX = 2 ** 31 - 1;

/**
 * Why a declaration may not be spliced into DDL, or `undefined`. Postgres' own ranges: a threshold
 * is an integer from 0 to `INT_MAX`, a scale factor a finite number from 0 to 100.
 */
export function autovacuumProblem(autovacuum: TableAutovacuum): string | undefined {
  for (const [key, value] of Object.entries(autovacuum)) {
    if (!(key in PARAMETERS)) return `autovacuum.${key} is not a parameter this declaration knows`;
    if (typeof value !== 'number') return `autovacuum.${key} is not a number`;
    const threshold = key.endsWith('Threshold');
    const fits = threshold
      ? Number.isInteger(value) && value >= 0 && value <= INT4_MAX
      : Number.isFinite(value) && value >= 0 && value <= 100;
    if (!fits) {
      return `autovacuum.${key} ${String(value)} is not ${threshold ? 'an integer from 0 to 2147483647' : 'a number from 0 to 100'}`;
    }
  }
  return undefined;
}

/** The declared parameters as `[name, value]`, in rendering order. */
export function autovacuumEntries(
  autovacuum: TableAutovacuum | undefined,
): readonly (readonly [AutovacuumParameter, number])[] {
  if (autovacuum === undefined) return [];
  return Object.entries(PARAMETERS).flatMap(([key, name]) => {
    const value = autovacuum[key as keyof TableAutovacuum];
    return value === undefined ? [] : [[name, value] as const];
  });
}

/** `name = value` for a `with (...)` or `set (...)` list. */
export const autovacuumSettings = (autovacuum: TableAutovacuum | undefined): readonly string[] =>
  autovacuumEntries(autovacuum).map(([name, value]) => `${name} = ${String(value)}`);

/** One option off `reloptions` joined by `, ` (`fillfactor=70, autovacuum_enabled=false`), or `null`. */
export function reloption(options: string | null, key: string): string | null {
  for (const option of (options ?? '').split(',')) {
    const [name, value] = option.trim().split('=');
    if (name === key && value !== undefined) return value;
  }
  return null;
}
