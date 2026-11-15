// The X_* codes of how an app is HELD — `x doctor`'s floor, pin, env, row-security, guard,
// superseded-workaround, advisory-floor and owed-codemod checks, the `exercise` floor and `drift`'s
// undeclared index. Split from `error-codes.ts` at its ceiling; it folds these into the CLI's one
// owned union and registers them in its one call; nothing else imports this file.

/** Codes `x doctor`, the `exercise` floor and the `drift` step's index advice declare and own. */
export const CLI_DOCTOR_ERROR_CODES = [
  'X_EXERCISE_UNPROVEN_ABOVE_FLOOR',
  'X_ENV_NAME_RESERVED',
  'X_FRAMEWORK_PIN_RANGE',
  'X_VERIFY_STEP_UNFLOORED',
  'X_DB_ROW_SECURITY_OFF',
  'X_DB_INDEX_UNDECLARED',
  'X_SHIPPED_GUARD_MISSING',
  'X_SUPERSEDED_WORKAROUND',
  'X_GUARD_VENDORED',
  'X_ADVISORY_FLOOR_UNMET',
  'X_UPGRADE_CODEMODS_PENDING',
] as const;

export type CliDoctorErrorCode = (typeof CLI_DOCTOR_ERROR_CODES)[number];

export const CLI_DOCTOR_ERROR_TITLES: Readonly<Record<CliDoctorErrorCode, string>> = {
  X_EXERCISE_UNPROVEN_ABOVE_FLOOR:
    'The exercise pass left more primitives unproven than x.verify.json allows',
  X_ENV_NAME_RESERVED: 'An app variable is named on a name the framework reads',
  X_FRAMEWORK_PIN_RANGE: 'An @ultimat3/* dependency is pinned as a range',
  X_VERIFY_STEP_UNFLOORED: 'A gate step applies to this app but x.verify.json does not floor it',
  X_DB_ROW_SECURITY_OFF: 'Raw sql reaches tenant tables while database.rowSecurity is off',
  X_DB_INDEX_UNDECLARED: 'Schema dump holds an index nothing declares',
  X_SHIPPED_GUARD_MISSING: "A guard x new ships is not in this app's guards/",
  X_SUPERSEDED_WORKAROUND: 'a workaround the framework has since retired is still in the app',
  X_GUARD_VENDORED: 'a guards/ copy of a shipped guard',
  X_ADVISORY_FLOOR_UNMET: 'a resolved dependency is below its advisory floor',
  X_UPGRADE_CODEMODS_PENDING: 'files an older x upgrade left for codemods',
};
