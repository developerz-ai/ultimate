// What a 5xx tells the author beyond its code: the coded error's cause, the statement or the fields
// it names, every value the call's input held under a credential key or a `.sensitive()` field
// masked out of the text. Without it, every X_DB_STATEMENT_FAILED in the pass was rerun by hand.

import { captureValue, isUltimateError, REDACTED, stringField } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';

/** What `ExerciseRecord.defect` holds. */
export interface ExerciseDefect {
  /** The error's own cause, credential values masked, cut at `MAX_DEFECT_CAUSE`. */
  readonly cause: string;
  /** The SQL a database refusal names (`… — statement: <sql>`), parameters as `$n`. */
  readonly statement?: string;
  /** The paths a validation failure names (`items.0.sku`). */
  readonly fields?: readonly string[];
}

/** A cause long enough for a SQLSTATE, its message and a capped statement; past it, cut. */
export const MAX_DEFECT_CAUSE = 600;

const STATEMENT = / — statement: (.+)$/s;

/** Every scalar the masked copy replaced: what must not appear in the cause either. */
function maskedScalars(original: unknown, masked: unknown, into: string[]): void {
  if (masked === REDACTED) {
    if (typeof original === 'string' || typeof original === 'number') into.push(String(original));
    return;
  }
  if (typeof original !== 'object' || original === null) return;
  if (typeof masked !== 'object' || masked === null) return;
  for (const [key, entry] of Object.entries(original)) {
    maskedScalars(entry, Reflect.get(masked, key), into);
  }
}

const fieldsOf = (meta: Readonly<Record<string, unknown>> | undefined): readonly string[] => {
  const issues = meta?.['issues'];
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    const path = stringField(issue, 'path');
    return path === undefined || path === '' ? [] : [path];
  });
};

/**
 * The detail of a CODED failure, or `undefined` for an uncoded throw — whose reason already is the
 * throw. `schema` is the primitive's input: its `.sensitive()` fields are masked as `redactKeys`
 * ones are (core's `captureValue`), so the record holds no value the audit log would not.
 */
export async function defectDetail(
  error: unknown,
  input: unknown,
  schema: StandardSchemaV1,
): Promise<ExerciseDefect | undefined> {
  if (!isUltimateError(error)) return undefined;
  // On demand: `@ultimat3/schema` is a dynamic-only dependency of this barrel (`CLAUDE.md`).
  const { maskSensitive } = await import('@ultimat3/schema');
  const secrets: string[] = [];
  maskedScalars(input, captureValue(maskSensitive(schema, input, REDACTED)).value, secrets);
  let cause = error.cause;
  for (const value of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    if (value !== '') cause = cause.split(value).join(REDACTED);
  }
  const statement = STATEMENT.exec(cause)?.[1]?.trim();
  const fields = fieldsOf(error.meta);
  return {
    cause: cause.length > MAX_DEFECT_CAUSE ? `${cause.slice(0, MAX_DEFECT_CAUSE - 1)}…` : cause,
    ...(statement === undefined || statement === '' ? {} : { statement }),
    ...(fields.length === 0 ? {} : { fields }),
  };
}
