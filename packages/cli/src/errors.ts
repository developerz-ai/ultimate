// The X_* codes owned by @ultimat3/cli. Every one names the exact command that resolves it,
// because the CLI is the surface an agent reads first — a failure here has to be actionable
// without a doc lookup or a second round-trip.
import { UltimateError } from '@ultimat3/core';

export const CLI_ERROR_CODES = [
  'X_CLI_UNKNOWN_COMMAND',
  'X_CLI_BAD_FLAG',
  'X_VERIFY_FAILED',
  'X_NOT_IN_APP',
  'X_BUN_VERSION',
  'X_NOT_IMPLEMENTED',
  'X_TEST_NO_FILES',
  'X_TEST_SHARD_FAILED',
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

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

/** An unknown flag, a missing value, or a value on a boolean flag. */
export class BadFlagError extends UltimateError {
  constructor(input: { flag: string; command: string; reason: string }) {
    super({
      code: 'X_CLI_BAD_FLAG',
      cause: `--${input.flag} on "x ${input.command}": ${input.reason}`,
      fix: `x ${input.command} --help`,
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
      fix: `x verify --only ${input.failed[0] ?? 'typecheck'} --json`,
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

/** `x test` discovered nothing. A green run over zero files is the most expensive false pass. */
export class NoTestFilesError extends UltimateError {
  constructor(input: { root: string; filter?: string }) {
    const where = input.filter === undefined ? '' : ` matching "${input.filter}"`;
    super({
      code: 'X_TEST_NO_FILES',
      cause: `no *.test.ts files${where} under ${input.root}`,
      fix: input.filter === undefined ? 'x test --cwd <repo root>' : 'x test',
      docs: docsFor('X_TEST_NO_FILES'),
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
