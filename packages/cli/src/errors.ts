// The X_* codes owned by @ultimat3/cli. Every one names the exact command that resolves it,
// because the CLI is the surface an agent reads first — a failure here has to be actionable
// without a doc lookup or a second round-trip.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

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
  'X_FILE_TOO_LONG',
  'X_PACKAGE_SHAPE',
  'X_RELEASE_VERSION_SKEW',
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
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s — `CliNotImplementedError` and every planned command
 * throw it, and none of them may declare a title for it. The CLI is the process that imports every
 * package (`error-catalog.ts`), so a title declared twice here is the one that would win by load
 * order rather than by ownership.
 */
export const CLI_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;

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
  X_CLI_UNEXPECTED: 'the CLI itself failed',
  X_TYPECHECK_FAILED: 'tsc failed',
  X_LINT_FAILED: 'Biome failed',
  X_TEST_FAILED: 'a test type failed',
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
};

// One unconditional call, so a second package claiming one of the CLI's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(CLI_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export const docsFor = (code: CliErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** An unknown command or subcommand. Carries a suggestion so the retry is one keystroke away. */
export class UnknownCommandError extends UltimateError {
  constructor(input: { path: string; known: readonly string[]; suggestion?: string }) {
    super({
      code: 'X_CLI_UNKNOWN_COMMAND',
      cause: `"x ${input.path}" is not a command (known: ${input.known.join(', ')})`,
      fix: input.suggestion === undefined ? 'x help' : `x ${input.suggestion}`,
      docs: docsFor('X_CLI_UNKNOWN_COMMAND'),
    });
  }
}

/**
 * An unknown flag, a missing value, a value on a boolean flag, or a value the command refuses.
 * `fix` defaults to the command's help; a caller that knows the working invocation passes it,
 * because a runnable command beats a page to read.
 */
export class BadFlagError extends UltimateError {
  constructor(input: { flag: string; command: string; reason: string; fix?: string }) {
    super({
      code: 'X_CLI_BAD_FLAG',
      cause: `--${input.flag} on "x ${input.command}": ${input.reason}`,
      fix: input.fix ?? `x ${input.command} --help`,
      docs: docsFor('X_CLI_BAD_FLAG'),
    });
  }
}

/** At least one `x verify` step failed. The step findings carry the per-step fixes. */
export class VerifyFailedError extends UltimateError {
  constructor(input: { failed: readonly string[] }) {
    super({
      code: 'X_VERIFY_FAILED',
      cause: `${input.failed.length} verify step(s) failed: ${input.failed.join(', ')}`,
      fix: 'x verify --json',
      docs: docsFor('X_VERIFY_FAILED'),
    });
  }
}

/** The command needs an app root (a directory containing `app.config.ts`) and found none. */
export class NotInAppError extends UltimateError {
  constructor(input: { command: string; from: string }) {
    super({
      code: 'X_NOT_IN_APP',
      cause: `"x ${input.command}" must run inside an Ultimate app; no app.config.ts at or above ${input.from}`,
      fix: 'x new myapp && cd myapp',
      docs: docsFor('X_NOT_IN_APP'),
    });
  }
}

/** Bun is older than the framework floor. Nothing else can be trusted until this is fixed. */
export class BunVersionError extends UltimateError {
  constructor(input: { found: string; required: string }) {
    super({
      code: 'X_BUN_VERSION',
      cause: `Bun ${input.found} is older than the required ${input.required}`,
      fix: 'bun upgrade',
      docs: docsFor('X_BUN_VERSION'),
    });
  }
}

/**
 * `x test` discovered nothing. A green run over zero files is the most expensive false pass, so
 * the selection that found nothing is named in full — a caller that cannot see whether the type
 * or the filter emptied the set has to guess which one to drop.
 */
export class NoTestFilesError extends UltimateError {
  constructor(input: { root: string; type?: string; filter?: string }) {
    const parts = [
      input.type === undefined ? undefined : `of type ${input.type}`,
      input.filter === undefined ? undefined : `matching "${input.filter}"`,
    ].filter((part): part is string => part !== undefined);
    const where = parts.length === 0 ? '' : ` ${parts.join(' ')}`;
    super({
      code: 'X_TEST_NO_FILES',
      cause: `no *.test.ts files${where} under ${input.root}`,
      fix: parts.length === 0 ? 'x test --cwd <repo root>' : 'x test',
      docs: docsFor('X_TEST_NO_FILES'),
    });
  }
}

/**
 * A generated path resolves outside the directory it is being written into — the scaffold gate's
 * sandbox, the app root `x g` writes into, or the catalog root a `--locales` segment names. `..`
 * or a separator would put template output on the developer's real disk, so it fails before the
 * write, not after. `fix` names the invocation that works when the caller knows it.
 */
export class ScaffoldPathEscapeError extends UltimateError {
  constructor(input: { path: string; dir: string; fix?: string }) {
    super({
      code: 'X_SCAFFOLD_PATH_ESCAPE',
      cause: `generated path "${input.path}" resolves outside ${input.dir}`,
      fix:
        input.fix ??
        `make the path relative to the app root with no ".." segment, then re-run: bun test packages/cli/src/scaffold-typecheck.contract.test.ts`,
      docs: docsFor('X_SCAFFOLD_PATH_ESCAPE'),
    });
  }
}

/**
 * A `merge: 'json'` `GeneratedFile` whose own `contents` do not parse as a JSON object — a bug in
 * the template that produced it, not a recoverable end-user situation. `dedupe()` (`cmd-generate.ts`)
 * throws this before the bad contributor can be silently treated as `{}` and merged into (or
 * written as) a catalog with attribution to nobody.
 */
export class GenerateJsonInvalidError extends UltimateError {
  constructor(input: { path: string }) {
    super({
      code: 'X_GENERATE_JSON_INVALID',
      cause: `${input.path} is declared merge: 'json' but the generator's own contents for it do not parse as a JSON object`,
      fix: `fix the template that emits ${input.path}, then re-run: bun test packages/cli/src/cmd-generate.test.ts`,
      docs: docsFor('X_GENERATE_JSON_INVALID'),
    });
  }
}

/**
 * `x i18n add <locale>` refuses to clobber a catalog that already exists — a human translation lost
 * to a second run is unrecoverable. `X_GENERATE_CONFLICT` is this package's own code, used until now
 * only as a `Finding` literal inside `cmd-generate.ts`'s `writeFiles`; this is the same registered
 * code thrown as a real `UltimateError`. The path arrives already computed rather than derived from
 * `catalogPath` here: `templates/locales.ts` imports this file, so calling back into it would close
 * an import cycle.
 */
export class CatalogExistsError extends UltimateError {
  constructor(input: { locale: string; path: string }) {
    super({
      code: 'X_GENERATE_CONFLICT',
      cause: `${input.path} already exists`,
      fix: `x i18n sync ${input.locale}`,
      docs: docsFor('X_GENERATE_CONFLICT'),
    });
  }
}

/**
 * The app's `package.json` cannot supply a name and a version. Defaulting to `app@0.0.0` would put
 * a fabricated identity into `x.manifest.json`, whose version IS the semver compatibility gate —
 * so the contract would be overwritten with a lie no downstream check could catch.
 */
export class AppPackageInvalidError extends UltimateError {
  constructor(input: { path: string; problem: string }) {
    super({
      code: 'X_APP_PACKAGE_INVALID',
      cause: `${input.path} ${input.problem}, so the manifest has no app name or version to gate on`,
      fix: 'bun pm pkg set name=<app> version=0.1.0',
      docs: docsFor('X_APP_PACKAGE_INVALID'),
    });
  }
}

/**
 * `x errors explain` was handed a code no package registered. Inventing an explanation is the one
 * answer worse than none: an agent would act on it. The suggestion makes the retry one keystroke.
 */
export class ErrorCodeUnknownError extends UltimateError {
  constructor(input: { code: string; suggestion?: string }) {
    super({
      code: 'X_ERROR_CODE_UNKNOWN',
      cause: `"${input.code}" is not a registered error code`,
      fix:
        input.suggestion === undefined
          ? 'x errors list --json'
          : `x errors explain ${input.suggestion}`,
      docs: docsFor('X_ERROR_CODE_UNKNOWN'),
    });
  }
}

/**
 * `x actions|queries|entities describe <name>` named a declaration the registries do not hold —
 * a typo, or a module that never imported. `known` is the count, not the list: a 200-action app
 * would bury the fix line under names nobody asked for, and `list` is one command away.
 */
export class DeclarationUnknownError extends UltimateError {
  constructor(input: {
    kind: string;
    singular: string;
    name: string;
    known: readonly string[];
    suggestion?: string;
    /** The subcommand that takes one name. `describe` for the registries, `show` for `x tasks`. */
    verb?: string;
  }) {
    super({
      code: 'X_DECLARATION_UNKNOWN',
      cause: `no ${input.singular} named "${input.name}" is registered (${input.known.length} known)`,
      fix:
        input.suggestion === undefined
          ? `x ${input.kind} list --json`
          : `x ${input.kind} ${input.verb ?? 'describe'} ${input.suggestion}`,
      docs: docsFor('X_DECLARATION_UNKNOWN'),
    });
  }
}

/** `x jobs show|retry <id>` against an id the queue does not hold — wrong id, or already reaped. */
export class JobUnknownError extends UltimateError {
  constructor(input: { id: string; driver: string }) {
    super({
      code: 'X_JOB_UNKNOWN',
      cause: `the "${input.driver}" queue holds no job with id "${input.id}"`,
      fix: 'x jobs ls --json',
      docs: docsFor('X_JOB_UNKNOWN'),
    });
  }
}

/**
 * `x fix boundary <file>` was pointed at something outside the app's surface graph. `suggestion`
 * is the nearest real path: repeating the caller's own failing argument back at them as the fix
 * is the shape "errors are instructions" exists to ban.
 */
export class FixTargetUnknownError extends UltimateError {
  constructor(input: { file: string; scanned: number; suggestion?: string }) {
    super({
      code: 'X_FIX_TARGET_UNKNOWN',
      cause: `"${input.file}" is not one of the ${input.scanned} source file(s) under apps/*/{site,app,api,shared}`,
      fix:
        input.suggestion === undefined
          ? 'x routes --json   # every registered route file, app-root-relative'
          : `x fix boundary ${input.suggestion}`,
      docs: docsFor('X_FIX_TARGET_UNKNOWN'),
    });
  }
}

/**
 * A build target names an entry file the app does not have. `x build` refuses before it spawns the
 * builder: `bun build`'s own "module not found" says nothing about which file an Ultimate app is
 * supposed to own, and `docker build`'s says nothing about which target wanted it.
 */
export class BuildEntryMissingError extends UltimateError {
  constructor(input: { target: string; entry: string }) {
    super({
      code: 'X_BUILD_ENTRY_MISSING',
      cause: `x build --target ${input.target} builds from ${input.entry}, and the app does not have it`,
      fix: `x new <name> writes ${input.entry} — copy it from a fresh scaffold into this app`,
      docs: docsFor('X_BUILD_ENTRY_MISSING'),
    });
  }
}

/**
 * `ROLE` selects what a container is. One image runs every role, so a typo is a process that would
 * otherwise start, serve nothing and report healthy — the one failure a rolling deploy cannot see.
 */
export class RoleUnknownError extends UltimateError {
  constructor(input: { role: string; known: readonly string[] }) {
    super({
      code: 'X_ROLE_UNKNOWN',
      cause: `ROLE="${input.role}" is not a role (known: ${input.known.join(', ')})`,
      fix: `docker run -e ROLE=web <image>   # one of: ${input.known.join(', ')}`,
      docs: docsFor('X_ROLE_UNKNOWN'),
    });
  }
}

/**
 * Every PaaS injects `PORT` and expects the process to bind exactly it. Defaulting past a value
 * that will not parse is how a deploy comes up on 3000, fails the platform's health probe, and
 * reports nothing an operator can act on.
 */
export class PortInvalidError extends UltimateError {
  constructor(input: { value: string }) {
    super({
      code: 'X_PORT_INVALID',
      cause: `PORT="${input.value}" is not a TCP port number between 0 and 65535`,
      fix: 'docker run -e PORT=3000 <image>',
      docs: docsFor('X_PORT_INVALID'),
    });
  }
}

/** An interface-complete command path whose remote/native half is not written yet. */
export class CliNotImplementedError extends UltimateError {
  constructor(input: { feature: string; fix: string }) {
    super({
      code: 'X_NOT_IMPLEMENTED',
      cause: `${input.feature} is not implemented in this build`,
      fix: input.fix,
      docs: docsFor('X_NOT_IMPLEMENTED'),
    });
  }
}
