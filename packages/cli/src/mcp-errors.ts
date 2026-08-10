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
  X_GENERATE_JSON_INVALID:
    'bun test packages/cli/src/cmd-generate.test.ts   # the error names the template to fix',
  X_APP_PACKAGE_INVALID: 'bun pm pkg set name=<app> version=0.1.0',
  X_ERROR_CODE_UNKNOWN: 'x errors list --json',
  X_DECLARATION_UNKNOWN: 'x actions list --json',
  X_JOB_UNKNOWN: 'x jobs ls --json',
  X_FIX_TARGET_UNKNOWN: 'x fix boundary apps/web/site/page.tsx',
  X_ERROR_FIX_INVALID: 'x verify --json   # the finding names the file, the line and the fix text',
  X_ERROR_CODE_UNDOCUMENTED: 'x verify --json   # the finding names the code and the missing page',
  X_ERROR_CODE_UNREGISTERED:
    'x errors list --json   # register the code in its package src/errors.ts, or move its row under "Reserved codes"',
  X_CLI_UNEXPECTED: 'x doctor --json',
  X_TYPECHECK_FAILED: 'bunx tsc -b --pretty false',
  X_LINT_FAILED: 'bunx biome check --write .',
  X_TEST_FAILED: 'x test --json   # the finding carries the exact bun test invocation that failed',
  X_FILE_TOO_LONG: 'x verify --json   # the finding names the file to split',
  X_PACKAGE_SHAPE: 'bun run scripts/new-package.ts <pkg> --only <file>',
  X_RELEASE_VERSION_SKEW: 'bun run scripts/release.ts --bump patch --dry-run --json',
  X_MANIFEST_STALE: 'x manifest',
  X_BUDGET_UNMEASURED: 'x build && x verify',
  X_BUILD_FAILED: 'x build --json   # the finding names the failing step',
  X_DEPLOY_FAILED: 'x deploy --json   # the finding carries the command to re-run directly',
  X_GENERATE_CONFLICT: 'x g <kind> <name> --force',
  X_PORT_IN_USE: 'x dev --port 3001',
  X_DB_GEN_FAILED: 'x db status --json',
  X_DB_MIGRATE_FAILED: 'x db status --json',
  X_DB_BRANCH_FAILED: 'x db branch ls --json',
  X_DB_STUDIO_FAILED: 'x doctor --json',
  X_BOUNDARY_SITE_TO_APP: 'x fix boundary <file>',
  X_BOUNDARY_SHARED_LEAF: 'x fix boundary <file>',
  X_BOUNDARY_APP_TO_API: 'x fix boundary <file>',
  X_BOUNDARY_ROUTE_TO_DB: 'x fix boundary <file>',
  X_BOUNDARY_SERVICE_TO_HTTP: 'x fix boundary <file>',
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
