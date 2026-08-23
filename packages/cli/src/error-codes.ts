// The X_* codes owned by @ultimat3/cli, and nothing else: the two lists, their titles, the one
// registration call. Every code names the exact command that resolves it, because
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
  // The second half of the same contract: X_ERROR_FIX_INVALID means the fix is not an instruction,
  // this one means it is one and cites a file that is not there. Two conditions, two repairs.
  'X_ERROR_FIX_PATH_MISSING',
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
  // The build graph's own membership rule. `tsc -b` compiles referenced projects and nothing
  // else, so a workspace no root reference names is one the `typecheck` step passes over without
  // reading — the hole that let `scripts/` hold seven type errors under a green gate.
  'X_PACKAGE_UNREFERENCED',
  'X_RELEASE_VERSION_SKEW',
  'X_STORAGE_UNWRITABLE',
  'X_STORAGE_SECRET_DEV',
  'X_MANIFEST_STALE',
  'X_BUDGET_UNMEASURED',
  // The other half of #271, and the half no runtime can raise: a route reads a live hook and boots
  // no module in a browser, so its rows have nowhere to arrive and the page renders its loading
  // branch forever, at 200. Only this package can see it — `@ultimat3/realtime` cannot see a route
  // and `@ultimat3/render` may not import realtime.
  'X_LIVE_ROUTE_NO_ISLAND',
  'X_BUILD_FAILED',
  'X_BUILD_ENTRY_MISSING',
  'X_DEPLOY_FAILED',
  // The two the container's own environment can get wrong. A PaaS injects `PORT` and a supervisor
  // injects `ROLE`; both arrive as strings from outside the app, so both are validated at boot
  // rather than defaulted — a web role that quietly bound 3000 when the platform said 8080 fails
  // its health check with nothing in the log that names the cause.
  'X_ROLE_UNKNOWN',
  'X_PORT_INVALID',
  'X_DEV_ALREADY_RUNNING',
  // The OTHER thing the preflight can find, and it was reported as the one above: an unreadable
  // lock this process could not remove made `DevAlreadyRunningError` name THIS pid as the holder,
  // so the remedy printed was `kill <self>` — unrunnable, and a cause that was simply untrue.
  'X_DEV_LOCK_UNREADABLE',
  // The boot's own consistency check. `startServices` captures the drivers it built, and
  // `loadApp` runs AFTER it — so an app module calling `setJobDriver(theirs)` moved the ambient
  // slot and left the captured object alone: every `handle.enqueue()` went to their queue while
  // the worker claimed from Postgres, and the `/_x` panel read the ambient one and agreed with
  // the enqueue side. Nothing failed. Refused here rather than documented, per axiom 3.
  'X_RUNTIME_DRIVER_SPLIT',
  'X_GENERATE_CONFLICT',
  'X_PORT_IN_USE',
  'X_DB_GEN_FAILED',
  'X_DB_MIGRATE_FAILED',
  'X_DB_BRANCH_FAILED',
  'X_DB_STUDIO_FAILED',
  // Refusing to seed production is a REFUSAL, not a malformed invocation, so it is not
  // `X_CLI_BAD_FLAG`: the argv was well formed and the answer is no. Its own code is what lets
  // `x errors explain` hand back the one remedy — name the tier — instead of the flag code's
  // "unknown flag, missing value, or a value the command refuses", which covers a dozen causes.
  'X_SEED_ENVIRONMENT',
  // The five app-surface boundary codes. `@ultimat3/render` owns the *rule* (`checkSurfaceBoundary`)
  // and the CLI owns the diagnostic, because `x verify` and `x fix boundary` are the two commands
  // that report it — see `app-boundaries.ts`, which holds the one rule-to-code table.
  'X_BOUNDARY_SITE_TO_APP',
  'X_BOUNDARY_SHARED_LEAF',
  'X_BOUNDARY_APP_TO_API',
  'X_BOUNDARY_ROUTE_TO_DB',
  'X_BOUNDARY_SERVICE_TO_HTTP',
  // The three ways an app's own guard can fail to be one. A guard is the app's convention made
  // into a build error, so a guard the gate cannot trust has to be a finding rather than a skip:
  // an app that believes its rule is enforced and is not is worse off than one with no rule.
  'X_GUARD_INVALID',
  'X_GUARD_FAILED',
  'X_GUARD_FINDING_INVALID',
  // The CLI's own declarations, held to each other. A flag the parser accepts and no code reads
  // is a promise in `x help` with nothing behind it — `x deploy --critical` said "forces clients
  // to reload" and reached no reader outside the plan JSON it was written into.
  'X_CLI_FLAG_UNREAD',
  // The two halves of `x secrets edit` that belong to the terminal rather than to the envelope.
  // `@ultimat3/core` owns every X_SECRETS_* code about the file and the key; an editor is the
  // CLI's problem alone, and core would have no `fix:` to offer for one.
  'X_SECRETS_EDITOR_MISSING',
  'X_SECRETS_EDIT_FAILED',
  'X_WORKSPACE_DEP_UNDECLARED',
  'X_SHOT_BROWSER_MISSING',
  'X_GH_UNAVAILABLE',
  'X_GH_NOT_AUTHENTICATED',
  'X_GH_COMMAND_FAILED',
  'X_GH_RESPONSE_INVALID',
  'X_PR_NOT_FOUND',
  'X_CI_RUN_NOT_FOUND',
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
 *
 * `X_ISLAND_INVALID` is `@ultimat3/render`'s and is borrowed for the same reason: "this src cannot
 * become a client entry" is what that code already means, and the bundler is simply the half that
 * can see whether the file exists. A CLI-owned twin would be one condition with two names.
 */
export const CLI_BORROWED_ERROR_CODES = [
  'X_NOT_IMPLEMENTED',
  'X_CONFIG_INVALID',
  'X_ENV_MISSING',
  'X_ENV_EXAMPLE_DRIFT',
  'X_ISLAND_INVALID',
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
  X_ERROR_FIX_PATH_MISSING: "an error's fix line cites a file this repository does not have",
  X_ERROR_CODE_UNDOCUMENTED: 'a shipped error code has no row in the error reference',
  X_ERROR_CODE_UNREGISTERED: 'the error reference documents a code no package registers',
  X_STORAGE_UNWRITABLE: 'the storage disk this process needs cannot be written to',
  X_STORAGE_SECRET_DEV: 'upload grants would be signed with the shipped development key',
  X_CLI_UNEXPECTED: 'the CLI itself failed',
  X_TYPECHECK_FAILED: 'tsc failed',
  X_LINT_FAILED: 'Biome failed',
  X_TEST_FAILED: 'a test type failed',
  X_VERIFY_SUITE_VANISHED: 'a step the committed floor requires had nothing left to check',
  X_FILE_TOO_LONG: 'a source file is over 500 lines',
  X_PACKAGE_SHAPE: 'a workspace package is missing a contract file',
  X_PACKAGE_UNREFERENCED: 'a published workspace is not in the root tsconfig build graph',
  X_RELEASE_VERSION_SKEW: 'a workspace is not at the lockstep version',
  X_MANIFEST_STALE: 'openapi.json is stale',
  X_BUDGET_UNMEASURED: 'a route declares a budget the build never measured',
  X_LIVE_ROUTE_NO_ISLAND: 'a route reads live rows and boots nothing that could receive them',
  X_BUILD_FAILED: 'x build failed',
  X_BUILD_ENTRY_MISSING: "the build target's entry file is not in the app",
  X_DEPLOY_FAILED: 'a deploy step failed',
  X_ROLE_UNKNOWN: 'ROLE names something that is not a role',
  X_PORT_INVALID: 'PORT is not a TCP port number',
  X_DEV_ALREADY_RUNNING: 'another x dev already owns this checkout',
  X_DEV_LOCK_UNREADABLE: 'the dev lock file cannot be read or removed',
  X_RUNTIME_DRIVER_SPLIT: 'the ambient driver is not the one this process serves',
  X_GENERATE_CONFLICT: 'a generator would overwrite a file',
  X_PORT_IN_USE: 'the dev port is taken',
  X_DB_GEN_FAILED: 'x db gen failed',
  X_DB_MIGRATE_FAILED: 'x db migrate failed',
  X_DB_BRANCH_FAILED: 'an x db branch step failed',
  X_DB_STUDIO_FAILED: 'x db studio failed',
  X_SEED_ENVIRONMENT: 'the seed tier is not one this environment runs',
  X_BOUNDARY_SITE_TO_APP: 'site/ imported app/',
  X_BOUNDARY_SHARED_LEAF: 'shared/ imported a surface',
  X_BOUNDARY_APP_TO_API: 'app/ imported api/ at runtime',
  X_BOUNDARY_ROUTE_TO_DB: 'a route touched the database',
  X_BOUNDARY_SERVICE_TO_HTTP: 'a service imported HTTP',
  X_GUARD_INVALID: 'a file in guards/ exports no usable guard',
  X_GUARD_FAILED: 'an app guard threw instead of returning findings',
  X_GUARD_FINDING_INVALID: "an app guard's finding breaks the error contract",
  X_CLI_FLAG_UNREAD: 'a command declares a flag no code reads',
  X_SECRETS_EDITOR_MISSING: 'no $EDITOR to open the decrypted secrets in',
  X_SECRETS_EDIT_FAILED: 'the editor exited non-zero, so nothing was resealed',
  X_WORKSPACE_DEP_UNDECLARED: 'a workspace imports another workspace it does not declare',
  X_SHOT_BROWSER_MISSING: 'x shot found no browser library in the app',
  X_GH_UNAVAILABLE: 'the GitHub CLI is not runnable from here',
  X_GH_NOT_AUTHENTICATED: 'gh holds no credentials for this host',
  X_GH_COMMAND_FAILED: 'a gh invocation exited non-zero',
  X_GH_RESPONSE_INVALID: "gh's output is not the shape the command reads",
  X_PR_NOT_FOUND: 'no pull request for this checkout',
  X_CI_RUN_NOT_FOUND: 'no workflow run for this branch',
};

// One unconditional call, so a second package claiming one of the CLI's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(CLI_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

// This file exports NO `docsFor(code)`, and adding one back is the defect. A CLI error passes no
// `docs:` at all — `UltimateError` fills it from `describeErrorCode(code).docs`, which is
// `@ultimat3/core`'s `ERROR_DOCS_URL`: one page for every code, never one per code, because `wiki/`
// is the framework's only public documentation surface and a code lives there in a TABLE ROW, which
// has no anchor. A `Finding` is a plain object with no constructor to fill it, so it carries
// `ERROR_DOCS_URL` imported from core — the same constant, not a second copy of it. The
// `https://ultimate.dev/errors/<code>` links `docsFor` built until 9.x answered 404, host included,
// on every error the CLI has ever thrown.
