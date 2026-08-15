// The error classes @ultimat3/cli throws. One class per condition, each naming the exact command
// that resolves it — the codes themselves, their titles and their registration are `./error-codes`,
// so a package importing a class does not pull the table and vice versa.
import { UltimateError } from '@ultimat3/core';
import { docsFor } from './error-codes';

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

/**
 * A required POSITIONAL argument that was not given. Its own class rather than a `BadFlagError`,
 * because the cause then names a flag that does not exist — `x errors --json` reported
 * `--code on "x errors"` and sent an agent straight into a second `X_CLI_BAD_FLAG` for the
 * `--code` flag it had just been told about — and rather than `X_CLI_UNKNOWN_COMMAND`, which said
 * "x g route is not a command" about a command form that is. `example` is a REAL invocation:
 * `x g route <name>` pasted into a shell is a redirect, not a command.
 */
export class MissingPositionalError extends UltimateError {
  constructor(input: { command: string; positional: string; example: string }) {
    super({
      code: 'X_CLI_BAD_FLAG',
      cause: `"x ${input.command}" needs a <${input.positional}> positional and got none`,
      fix: input.example,
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
      fix: parts.length === 0 ? 'x test --json   # run it from the repo root' : 'x test',
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
      fix: 'bun pm pkg set name=my-app version=0.1.0',
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
      fix: `x new scratch-app --dry-run --json   # its file list carries ${input.entry}; copy that file into this app`,
      docs: docsFor('X_BUILD_ENTRY_MISSING'),
    });
  }
}

/**
 * A client entry would not compile. `X_BUILD_FAILED`, not a code of its own: an island is a bundle
 * entry point like any other, and the target's own logs are what says which line. The fix builds
 * exactly that one file, so the next message an author reads is the compiler's and not the CLI's.
 */
export class IslandBuildFailedError extends UltimateError {
  constructor(input: { file: string; logs: string }) {
    super({
      code: 'X_BUILD_FAILED',
      cause: `${input.file} is an island entry point and would not bundle: ${input.logs}`,
      fix: `bun build --target browser ${input.file}`,
      docs: docsFor('X_BUILD_FAILED'),
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
      fix: `docker run -e ROLE=web my-app:latest   # one of: ${input.known.join(', ')}`,
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
  /** `name` so the scrape port reports itself; the code stays one, because the fault is one. */
  constructor(input: { value: string; name?: string }) {
    const name = input.name ?? 'PORT';
    super({
      code: 'X_PORT_INVALID',
      cause: `${name}="${input.value}" is not a TCP port number between 0 and 65535`,
      fix: `docker run -e ${name}=${name === 'PORT' ? 3000 : 9090} my-app:latest`,
      docs: docsFor('X_PORT_INVALID'),
    });
  }
}

/**
 * `x env` was run in an app whose `app.config.ts` exports no `envSchema`. Not a silent success:
 * writing a `.env.example` with no variables in it, or reporting "0 declared variables, all
 * present", both read as a working environment declaration to whoever runs the command next.
 *
 * `X_CONFIG_INVALID` is core's code for "a configuration this process cannot boot on — env or
 * `app.config.ts`", which is exactly this; the CLI names it in `CLI_BORROWED_ERROR_CODES` rather
 * than minting a synonym.
 */
export class EnvSchemaMissingError extends UltimateError {
  constructor(input: { subcommand: string }) {
    super({
      code: 'X_CONFIG_INVALID',
      cause: `x env ${input.subcommand} needs the env declaration, and app.config.ts exports no "envSchema"`,
      fix: "add to app.config.ts: export const envSchema = { DATABASE_URL: { type: 'url', description: 'Postgres connection URL' } } satisfies EnvSchema; export const env = defineEnv(envSchema);",
      docs: docsFor('X_CONFIG_INVALID'),
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

/**
 * The process could not obtain a storage disk to write to.
 *
 * Thrown at boot rather than at the first upload, and with a `fix` naming the two real options —
 * a writable volume or an object store — because the failure it replaces was a bare `EROFS` from
 * inside Bun's `mkdirSync`, with no code, no fix, and no mention of storage. A hardened container
 * (`readOnlyRootFilesystem: true`) CrashLooped 22 times on it before anyone could tell what the
 * process wanted.
 */
export class StorageUnwritableError extends UltimateError {
  constructor(cause: string, fix: string) {
    super({ code: 'X_STORAGE_UNWRITABLE', cause, fix, docs: docsFor('X_STORAGE_UNWRITABLE') });
  }
}

/**
 * A non-local boot that fell through to the embedded disk with no `STORAGE_SIGNING_SECRET`. The
 * key it would sign with is a string published in this repo, and `acceptSignedUpload` trusts a
 * signed `maxBytes`/`contentType` over the app's own `uploadPolicy` — so anyone holding it mints
 * an unlimited upload of any type, for any key, including another org's.
 *
 * `X_ENV_MISSING`, the code `@ultimat3/storage` already refuses this with, rather than a CLI twin:
 * two codes for one condition is what `cmd-doctor.ts` says out loud about the PWA pair. What this
 * adds is the sentence storage cannot write — that the disk itself was a fallback nobody chose.
 * The fix names object storage first, because that is the answer for most deployments; the volume
 * rung is behind the `#`, so the line still runs verbatim.
 */
export class LocalDiskUnsafeError extends UltimateError {
  constructor(input: { environment: string; root: string }) {
    super({
      code: 'X_ENV_MISSING',
      cause:
        `no S3_ENDPOINT/S3_BUCKET, so this ${input.environment} process fell back to the embedded ` +
        `disk at ${input.root} — and with no STORAGE_SIGNING_SECRET it would sign upload grants ` +
        'with the development key published in @ultimat3/storage',
      fix: 'export S3_ENDPOINT=https://s3.example.com S3_BUCKET=my-app-uploads   # or keep the disk on a mounted volume: export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"',
      docs: docsFor('X_ENV_MISSING'),
    });
  }
}

/**
 * `x secrets edit` decrypts into a buffer and hands it to `$EDITOR`. There is no fallback editor:
 * guessing one and opening a decrypted file in it is the last place a surprise belongs.
 */
export class SecretsEditorMissingError extends UltimateError {
  constructor(input: { vars: readonly string[] }) {
    super({
      code: 'X_SECRETS_EDITOR_MISSING',
      cause: `x secrets edit opens the decrypted secrets in an editor and none of ${input.vars.join(', ')} is set`,
      fix: 'EDITOR=nano x secrets edit',
      docs: docsFor('X_SECRETS_EDITOR_MISSING'),
    });
  }
}

/**
 * The editor exited non-zero — a crash, or a deliberate abort. The buffer is discarded either way
 * and the committed file is left exactly as it was: resealing a buffer whose editor failed would
 * commit whatever half-written state the crash left behind.
 */
export class SecretsEditFailedError extends UltimateError {
  constructor(input: { editor: string; code: number }) {
    super({
      code: 'X_SECRETS_EDIT_FAILED',
      cause: `"${input.editor}" exited ${input.code}, so the decrypted buffer was discarded and the committed secrets file was not rewritten`,
      fix: 'x secrets edit',
      docs: docsFor('X_SECRETS_EDIT_FAILED'),
    });
  }
}

/**
 * `x secrets init` would overwrite a file that already exists. `X_GENERATE_CONFLICT` is this
 * package's own code for exactly that, and a second name for "a generator would clobber something"
 * is the duplication the code registry exists to prevent. Losing a master key is unrecoverable —
 * the committed file it opens is then ciphertext nobody can read again.
 */
export class SecretsExistsError extends UltimateError {
  constructor(input: { path: string; fix: string }) {
    super({
      code: 'X_GENERATE_CONFLICT',
      cause: `${input.path} already exists, and x secrets init would replace it`,
      fix: input.fix,
      docs: docsFor('X_GENERATE_CONFLICT'),
    });
  }
}
