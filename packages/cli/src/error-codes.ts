// The X_* codes owned by @ultimat3/cli, and nothing else: the two lists, their titles, the one
// registration call and `docsFor`. Every code names the exact command that resolves it, because
// the CLI is the surface an agent reads first — a failure here has to be actionable without a doc
// lookup or a second round-trip. The classes that throw these codes live in `./errors`.
import { registerErrorCodes } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const CLI_OWNED_ERROR_CODES = [
  'X_CLI_UNKNOWN_COMMAND',
  'X_CLI_BAD_FLAG',
  'X_VERIFY_FAILED',
  'X_NOT_IN_APP',
  'X_BUN_VERSION',
  'X_TEST_NO_FILES',
  'X_TEST_SHARD_FAILED',
  'X_SCAFFOLD_PATH_ESCAPE',
  'X_GENERATE_JSON_INVALID',
  'X_APP_PACKAGE_INVALID',
  'X_ERROR_CODE_UNKNOWN',
  'X_DECLARATION_UNKNOWN',
  'X_JOB_UNKNOWN',
  'X_FIX_TARGET_UNKNOWN',
  'X_ERROR_FIX_INVALID',
  'X_ERROR_CODE_UNDOCUMENTED',
  'X_ERROR_CODE_UNREGISTERED',
  // Reported as `Finding`s rather than thrown, and unregistered until now because of it — so
  // `x errors explain X_TYPECHECK_FAILED` refused a code `x verify` had just printed. A finding
  // carries an `X_*` code to the same reader a throw does; the registry is what makes that code
  // explainable, unique and documented-or-fail, so a code the CLI emits is a code the CLI owns.
  'X_CLI_UNEXPECTED',
  'X_TYPECHECK_FAILED',
  'X_LINT_FAILED',
  'X_TEST_FAILED',
  // The ratchet's own code. A skipped step is not a failure — unless `x.verify.json` says this
  // repo already ran it, in which case the suite was deleted and the gate would otherwise print
  // one more green line for it.
  'X_VERIFY_SUITE_VANISHED',
  'X_FILE_TOO_LONG',
  'X_PACKAGE_SHAPE',
  'X_RELEASE_VERSION_SKEW',
  'X_STORAGE_UNWRITABLE',
  'X_MANIFEST_STALE',
  'X_BUDGET_UNMEASURED',
  'X_BUILD_FAILED',
  'X_BUILD_ENTRY_MISSING',
  'X_DEPLOY_FAILED',
  // The two the container's own environment can get wrong. A PaaS injects `PORT` and a supervisor
  // injects `ROLE`; both arrive as strings from outside the app, so both are validated at boot
  // rather than defaulted — a web role that quietly bound 3000 when the platform said 8080 fails
  // its health check with nothing in the log that names the cause.
  'X_ROLE_UNKNOWN',
  'X_PORT_INVALID',
  'X_GENERATE_CONFLICT',
  'X_PORT_IN_USE',
  'X_DB_GEN_FAILED',
  'X_DB_MIGRATE_FAILED',
  'X_DB_BRANCH_FAILED',
  'X_DB_STUDIO_FAILED',
  // The five app-surface boundary codes. `@ultimat3/render` owns the *rule* (`checkSurfaceBoundary`)
  // and the CLI owns the diagnostic, because `x verify` and `x fix boundary` are the two commands
  // that report it — see `app-boundaries.ts`, which holds the one rule-to-code table.
  'X_BOUNDARY_SITE_TO_APP',
  'X_BOUNDARY_SHARED_LEAF',
  'X_BOUNDARY_APP_TO_API',
  'X_BOUNDARY_ROUTE_TO_DB',
  'X_BOUNDARY_SERVICE_TO_HTTP',
  // The two halves of `x secrets edit` that belong to the terminal rather than to the envelope.
  // `@ultimat3/core` owns every X_SECRETS_* code about the file and the key; an editor is the
  // CLI's problem alone, and core would have no `fix:` to offer for one.
  'X_SECRETS_EDITOR_MISSING',
  'X_SECRETS_EDIT_FAILED',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s — `CliNotImplementedError` and every planned command
 * throw it, and none of them may declare a title for it. The CLI is the process that imports every
 * package (`error-catalog.ts`), so a title declared twice here is the one that would win by load
 * order rather than by ownership.
 *
 * The three env codes are core's for the same reason: `defineEnv`, `checkEnv` and the
 * `.env.example` projection all live in `@ultimat3/core`, and `x env` is the surface that reports
 * them. A fourth code meaning "the example is stale" would be this package inventing a second name
 * for a condition core already named.
 */
export const CLI_BORROWED_ERROR_CODES = [
  'X_NOT_IMPLEMENTED',
  'X_CONFIG_INVALID',
  'X_ENV_MISSING',
  'X_ENV_EXAMPLE_DRIFT',
] as const;

/** Every code the CLI can throw: the ones it owns plus the one it borrows. */
export const CLI_ERROR_CODES = [...CLI_OWNED_ERROR_CODES, ...CLI_BORROWED_ERROR_CODES] as const;

export type CliOwnedErrorCode = (typeof CLI_OWNED_ERROR_CODES)[number];
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

/**
 * Registered titles, so `x errors list` enumerates the CLI's codes alongside every other
 * package's instead of leaving a hole an agent has to read source to fill. Typed over
 * `CliOwnedErrorCode`, so adding a code without a title is a build error.
 */
export const CLI_ERROR_TITLES: Readonly<Record<CliOwnedErrorCode, string>> = {
  X_CLI_UNKNOWN_COMMAND: 'not a command in the registry',
  X_CLI_BAD_FLAG: 'unknown flag, missing value, or a value the command refuses',
  X_VERIFY_FAILED: 'at least one x verify step failed',
  X_NOT_IN_APP: 'the command needs an app root and found none',
  X_BUN_VERSION: 'Bun is older than the framework floor',
  X_TEST_NO_FILES: 'the test selection matched no files',
  X_TEST_SHARD_FAILED: 'a test shard exited non-zero',
  X_SCAFFOLD_PATH_ESCAPE: 'a generated path resolves outside the directory it is written into',
  X_GENERATE_JSON_INVALID: "a generator's own merge: 'json' output does not parse as a JSON object",
  X_APP_PACKAGE_INVALID: "the app's package.json supplies no name and version",
  X_ERROR_CODE_UNKNOWN: 'no package registered this error code',
  X_DECLARATION_UNKNOWN: 'no declaration with this name is registered',
  X_JOB_UNKNOWN: 'the queue holds no job with this id',
  X_FIX_TARGET_UNKNOWN: 'the named file is not one of the app source files',
  X_ERROR_FIX_INVALID: "an error's fix line is not a runnable instruction",
  X_ERROR_CODE_UNDOCUMENTED: 'a shipped error code has no row in the error reference',
  X_ERROR_CODE_UNREGISTERED: 'the error reference documents a code no package registers',
  X_STORAGE_UNWRITABLE: 'the storage disk this process needs cannot be written to',
  X_CLI_UNEXPECTED: 'the CLI itself failed',
  X_TYPECHECK_FAILED: 'tsc failed',
  X_LINT_FAILED: 'Biome failed',
  X_TEST_FAILED: 'a test type failed',
  X_VERIFY_SUITE_VANISHED: 'a step the committed floor requires had nothing left to check',
  X_FILE_TOO_LONG: 'a source file is over 500 lines',
  X_PACKAGE_SHAPE: 'a workspace package is missing a contract file',
  X_RELEASE_VERSION_SKEW: 'a workspace is not at the lockstep version',
  X_MANIFEST_STALE: 'openapi.json is stale',
  X_BUDGET_UNMEASURED: 'a route declares a budget the build never measured',
  X_BUILD_FAILED: 'x build failed',
  X_BUILD_ENTRY_MISSING: "the build target's entry file is not in the app",
  X_DEPLOY_FAILED: 'a deploy step failed',
  X_ROLE_UNKNOWN: 'ROLE names something that is not a role',
  X_PORT_INVALID: 'PORT is not a TCP port number',
  X_GENERATE_CONFLICT: 'a generator would overwrite a file',
  X_PORT_IN_USE: 'the dev port is taken',
  X_DB_GEN_FAILED: 'x db gen failed',
  X_DB_MIGRATE_FAILED: 'x db migrate failed',
  X_DB_BRANCH_FAILED: 'an x db branch step failed',
  X_DB_STUDIO_FAILED: 'x db studio failed',
  X_BOUNDARY_SITE_TO_APP: 'site/ imported app/',
  X_BOUNDARY_SHARED_LEAF: 'shared/ imported a surface',
  X_BOUNDARY_APP_TO_API: 'app/ imported api/ at runtime',
  X_BOUNDARY_ROUTE_TO_DB: 'a route touched the database',
  X_BOUNDARY_SERVICE_TO_HTTP: 'a service imported HTTP',
  X_SECRETS_EDITOR_MISSING: 'no $EDITOR to open the decrypted secrets in',
  X_SECRETS_EDIT_FAILED: 'the editor exited non-zero, so nothing was resealed',
};

// One unconditional call, so a second package claiming one of the CLI's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(CLI_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export const docsFor = (code: CliErrorCode): string => `https://ultimate.dev/errors/${code}`;
