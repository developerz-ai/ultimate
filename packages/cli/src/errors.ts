// The error classes @ultimat3/cli throws. One class per condition, each naming the exact command
// that resolves it — the codes themselves, their titles and their registration are `./error-codes`,
// so a package importing a class does not pull the table and vice versa.
import { UltimateError } from '@ultimat3/core';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** An unknown command or subcommand. Carries a suggestion so the retry is one keystroke away. */
export class UnknownCommandError extends UltimateError {
  constructor(input: { path: string; known: readonly string[]; suggestion?: string }) {
    super({
      code: 'X_CLI_UNKNOWN_COMMAND',
      cause: `"x ${input.path}" is not a command (known: ${input.known.join(', ')})`,
      fix: input.suggestion === undefined ? 'x help' : `x ${input.suggestion}`,
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
    });
  }
}

/**
 * `x new /srv/apps/shop` — a PATH where a NAME goes.
 *
 * `names()` slugifies whatever it is given, so the separators became hyphens and the whole path
 * turned into ONE directory inside the cwd: `x new /tmp/probe/vision` wrote `tmp-probe-vision`
 * into the current directory and `git init`-ed it there. Nothing failed, and the app the caller
 * asked for did not exist.
 *
 * `--dir` is the flag that takes a path, so the two are one flag apart and the fix is the
 * invocation the caller meant — built from what they typed, never a placeholder.
 */
export class AppNameIsPathError extends UltimateError {
  constructor(input: { name: string; parent: string; base: string; invocation?: string }) {
    // The invocation the caller typed, not the literal `x new`: the same command is the whole of
    // `bunx create-ultimate`, which runs before `x` is installed.
    const invocation = input.invocation ?? 'x new';
    super({
      code: 'X_CLI_BAD_FLAG',
      cause: `"${invocation}" takes a NAME and got the path "${input.name}" — it would be slugified into one directory name`,
      fix: `${invocation} ${quoteArg(input.base)} --dir ${quoteArg(input.parent)}`,
    });
  }
}

/**
 * `x new '!!!'`: a name that slugifies to nothing names no directory, and the scaffold landed in
 * the cwd itself — where `--force` then committed every file the user already had there.
 */
export class AppNameEmptyError extends UltimateError {
  constructor(input: { name: string; invocation: string; flags: readonly string[] }) {
    super({
      code: 'X_APP_NAME_EMPTY',
      cause: `"${input.name}" has no letters or digits, so it names no directory`,
      fix: [input.invocation, '<name-with-letters>', ...input.flags].join(' '),
    });
  }
}

/**
 * A command that declares subcommands, invoked with none and declaring no `defaultSubcommand`.
 *
 * `X_CLI_BAD_FLAG` is the code a missing positional already takes (`MissingPositionalError`), and a
 * subcommand is one — a second code for "you left out an argument" is the synonym the registry
 * exists to prevent. Its own class because the cause must not name a flag: the parser answered
 * `subcommands[0]` before this existed, so `x db` ran `gen` and wrote a migration file nobody asked
 * for. Help is the fix because which of six was meant is exactly what the caller did not say.
 *
 * `x help <command>`, never `x <command> --help`: the parser resolves the subcommand AFTER the
 * flag loop, so `x db --help` throws THIS error again — a fix line that reproduces its own
 * failure, verbatim, forever. `x help db` prints the subcommand list and the flags.
 */
export class MissingSubcommandError extends UltimateError {
  constructor(input: { command: string; known: readonly string[] }) {
    super({
      code: 'X_CLI_BAD_FLAG',
      cause: `"x ${input.command}" takes a subcommand and got none (one of: ${input.known.join(', ')})`,
      fix: `x help ${input.command}`,
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
    });
  }
}

/** Which framework script a page ships: the sync worker, the page boot, or the client router. */
export type FrameworkScriptKind = 'sync worker' | 'page boot' | 'client router';

/**
 * One of the page's framework scripts would not bundle. Same code as an island: "a browser entry
 * the framework builds did not build" is one condition, and the entry here is framework code, not
 * the app's — the cause names WHICH script, so the reader knows what the page is now missing.
 */
export class FrameworkScriptBuildFailedError extends UltimateError {
  constructor(input: { what: FrameworkScriptKind; entry: string; logs: string }) {
    super({
      code: 'X_BUILD_FAILED',
      cause: `the ${input.what} (${input.entry}) would not bundle for the browser: ${input.logs}`,
      fix: `bun build --target browser --format iife ${quoteArg(input.entry)}`,
    });
  }
}

/**
 * A static build over an app whose modules did not all import. The route registry is filled BY the
 * import, so a page whose module threw is not skipped but absent — and an export without it, with
 * `x build` green, is a deploy that deletes a page. The `manifest` step owns load findings
 * (`load-findings.ts`), so the fix is the command that lists every one with its own fix.
 */
export class PrerenderLoadFailedError extends UltimateError {
  constructor(findings: readonly Finding[]) {
    const listed = findings.map((finding) =>
      finding.at === undefined
        ? `${finding.code} ${finding.cause}`
        : `${finding.at}: ${finding.code} ${finding.cause}`,
    );
    super({
      code: 'X_BUILD_FAILED',
      cause: `the static export renders the routes the app's modules register, and ${findings.length} module load finding(s) left it short: ${listed.join('; ')}`,
      fix: 'x verify --only manifest --json',
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
    });
  }
}

/**
 * The enqueue side and the claim side are looking at two different queues.
 *
 * `startServices` builds the drivers and captures them; `loadApp` imports the app's modules after
 * it, and a module calling `setJobDriver()` at import time moves the ambient slot without touching
 * the captured object. The worker then claims from what was captured while every
 * `handle.enqueue()` publishes to what is ambient — jobs that are accepted, acknowledged, visible
 * in `/_x` and never run. Refused at boot, because the alternative is a deployment that only ever
 * looks healthy.
 */
export class RuntimeDriverSplitError extends UltimateError {
  constructor(input: { driver: string; ambient: string; captured: string }) {
    super({
      code: 'X_RUNTIME_DRIVER_SPLIT',
      // Both names are printed even when they are the same string — two `memory` drivers are two
      // queues, and "they match" is exactly the reading that makes this bug invisible.
      cause: `an app module installed a ${input.driver} driver (ambient: "${input.ambient}") that is not the object this boot captured ("${input.captured}"), so enqueues and claims would use different queues`,
      fix: `pass the driver to the boot instead of installing it from an app module: runRole({ root, env, runtime: { ${input.driver}: yourDriver } })`,
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
    super({ code: 'X_STORAGE_UNWRITABLE', cause, fix });
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
    });
  }
}
