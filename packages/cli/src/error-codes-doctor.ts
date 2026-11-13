// The X_* codes of how an app is HELD — `x doctor`'s floor, pin, env-name and row-security checks,
// the `exercise` floor in `x.verify.json` and the `drift` step's undeclared index — split out of `error-codes.ts` at its 500-line
// ceiling, as `error-codes-shot.ts` was. `error-codes.ts` folds these into the CLI's one owned union
// and registers them in its one call; nothing else imports this file.

/** Codes `x doctor`, the `exercise` floor and the `drift` step's index advice declare and own. */
export const CLI_DOCTOR_ERROR_CODES = [
  'X_EXERCISE_UNPROVEN_ABOVE_FLOOR',
  'X_ENV_NAME_RESERVED',
  'X_FRAMEWORK_PIN_RANGE',
  'X_VERIFY_STEP_UNFLOORED',
  'X_DB_ROW_SECURITY_OFF',
  'X_DB_INDEX_UNDECLARED',
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
};
