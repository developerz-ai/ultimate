// `errors.explain`: one runnable command per error code. Its own file because the CLI's fix table
// is a contract — a code without a command is the thing "errors are instructions" exists to
// prevent, and the typed record below is what makes forgetting one a build error.

import { describeErrorCode, hasErrorCode, listErrorCodes } from '@ultimat3/core';
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
  X_ERROR_CODE_UNKNOWN: 'x errors list --json',
  X_DECLARATION_UNKNOWN: 'x actions list --json',
  X_JOB_UNKNOWN: 'x jobs ls --json',
  X_FIX_TARGET_UNKNOWN: 'x fix boundary apps/web/site/page.tsx',
  X_ERROR_FIX_INVALID: 'x verify --json   # the finding names the file, the line and the fix text',
  X_ERROR_CODE_UNDOCUMENTED: 'x verify --json   # the finding names the code and the missing page',
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

/**
 * Every code an agent can be handed, in one sorted list. Reads the framework-wide registry rather
 * than a second table: `errors.ts` registers the CLI's own titles at import, so a code that is
 * missing here is a code nobody registered — which is exactly what the list should show.
 */
export function explainEveryErrorCode(): readonly ErrorExplanation[] {
  const explained: ErrorExplanation[] = [];
  for (const entry of listErrorCodes()) {
    const explanation = explainErrorCode(entry.code);
    if (explanation !== undefined) explained.push(explanation);
  }
  return explained;
}
