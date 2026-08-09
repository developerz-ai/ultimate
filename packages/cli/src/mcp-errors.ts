// `errors.explain`: one runnable command per error code. Its own file because the CLI's fix table
// is a contract — a code without a command is the thing "errors are instructions" exists to
// prevent, and the typed record below is what makes forgetting one a build error.

import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import type { ErrorExplanation } from '@ultimat3/mcp';
import type { CliErrorCode } from './errors';
import { CLI_ERROR_CODES, docsFor } from './errors';

/** One runnable command per CLI code. Typed over `CliErrorCode`, so a new code fails the build. */
const CLI_FIXES: Readonly<Record<CliErrorCode, string>> = {
  X_CLI_UNKNOWN_COMMAND: 'x help',
  X_CLI_BAD_FLAG: 'x help <command>',
  X_VERIFY_FAILED: 'x verify --json',
  X_NOT_IN_APP: 'x new myapp && cd myapp',
  X_BUN_VERSION: 'bun upgrade',
  X_NOT_IMPLEMENTED: 'x doctor --json',
  X_TEST_NO_FILES: 'x test --cwd <repo root>',
  X_TEST_SHARD_FAILED: 'x test --workers 1',
  X_SCAFFOLD_PATH_ESCAPE: 'x g route <name>   # a path with no ".." segment',
  X_APP_PACKAGE_INVALID: 'bun pm pkg set name=<app> version=0.1.0',
};

const isCliCode = (code: string): code is CliErrorCode =>
  (CLI_ERROR_CODES as readonly string[]).includes(code);

/**
 * `undefined` for a code nobody registered — the tool then answers "unknown error code", which
 * beats an invented explanation. The framework-wide registry holds a title and a docs URL but no
 * fix (a thrown error carries its own), so a non-CLI code points at the gate that surfaces it.
 */
export function explainErrorCode(code: string): ErrorExplanation | undefined {
  const cli = isCliCode(code);
  if (!cli && !hasErrorCode(code)) return undefined;
  const described = describeErrorCode(code);
  return {
    code,
    cause: described.title,
    fix: cli ? CLI_FIXES[code] : 'x verify --json',
    docs: cli ? docsFor(code) : described.docs,
  };
}
