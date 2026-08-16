// `errors.explain`: one runnable command per error code. Its own file because the CLI's fix table
// is a contract — a code without a command is the thing "errors are instructions" exists to
// prevent, and the typed record below is what makes forgetting one a build error.

import { describeErrorCode, hasErrorCode, listErrorCodes } from '@ultimat3/core';
import type { ErrorExplanation } from '@ultimat3/mcp';
import type { CliErrorCode } from './error-codes';
import { CLI_ERROR_CODES, docsFor } from './error-codes';

/**
 * One runnable command per CLI code. Typed over `CliErrorCode`, so a new code fails the build.
 *
 * Every `x` invocation here carries `--json`, because that is the flag the whole CLI is built
 * around (`GLOBAL_FLAGS` in `parse.ts`, axiom 4): the agent that was handed one of these fixes ran
 * a machine-readable command to get here, and a fix that drops back to prose breaks the loop it is
 * meant to close. `bun`, `bunx` and the gate scripts keep their own surfaces — `--json` is the
 * `x` CLI's contract, not a universal one.
 */
const CLI_FIXES: Readonly<Record<CliErrorCode, string>> = {
  X_CLI_UNKNOWN_COMMAND: 'x help --json',
  // Runnable first, the narrowing behind a `#`: `x help <command> --json` pasted into a shell
  // is a redirect, not a command, and this table is copied verbatim by whoever reads it.
  X_CLI_BAD_FLAG: 'x help --json   # then narrow to the command the cause names',
  X_VERIFY_FAILED: 'x verify --json',
  X_NOT_IN_APP: 'x new myapp --json && cd myapp',
  X_BUN_VERSION: 'bun upgrade',
  X_NOT_IMPLEMENTED: 'x doctor --json',
  // Core's three env codes, answered by the command that covers each. `X_CONFIG_INVALID` gets
  // `x doctor` rather than `x env check`: its causes are env *and* `app.config.ts` fields, and
  // `x env check` on a config the app cannot boot on would throw this same code straight back.
  X_CONFIG_INVALID: 'x doctor --json',
  X_ENV_MISSING: 'x env check --json',
  X_ENV_EXAMPLE_DRIFT: 'x env example --json',
  X_TEST_NO_FILES: 'x test --json   # from the repo root, or pass --cwd to it',
  X_TEST_SHARD_FAILED: 'x test --workers 1 --json',
  X_SCAFFOLD_PATH_ESCAPE: 'x g route posts --json   # a path with no ".." segment',
  X_GENERATE_JSON_INVALID:
    'bun test packages/cli/src/cmd-generate.test.ts   # the error names the template to fix',
  X_APP_PACKAGE_INVALID: 'bun pm pkg set name=my-app version=0.1.0',
  X_ERROR_CODE_UNKNOWN: 'x errors list --json',
  X_DECLARATION_UNKNOWN: 'x actions list --json',
  X_JOB_UNKNOWN: 'x jobs ls --json',
  X_FIX_TARGET_UNKNOWN: 'x fix boundary apps/web/site/page.tsx --json',
  X_ERROR_FIX_INVALID: 'x verify --json   # the finding names the file, the line and the fix text',
  X_ERROR_CODE_UNDOCUMENTED: 'x verify --json   # the finding names the code and the missing page',
  X_ERROR_CODE_UNREGISTERED:
    'x errors list --json   # register the code in its package src/errors.ts, or move its row under "Reserved codes"',
  X_CLI_UNEXPECTED: 'x doctor --json',
  X_TYPECHECK_FAILED: 'bunx tsc -b --pretty false',
  X_LINT_FAILED: 'bunx biome check --write .',
  X_TEST_FAILED: 'x test --json   # the finding carries the exact bun test invocation that failed',
  // The same two edits `vanishedSuiteFinding` names, verbatim, so both surfaces of this code hand
  // an agent one instruction. Neither edit is scripted here on purpose: a command that rewrites
  // x.verify.json is the gate editing its own ratchet, which is the false green the floor closes.
  X_VERIFY_SUITE_VANISHED:
    'x verify --json   # restore the suite, or drop its name from x.verify.json in the commit that says why',
  X_FILE_TOO_LONG: 'x verify --json   # the finding names the file to split',
  X_PACKAGE_SHAPE: 'bun run verify --json   # every finding carries its own new-package.ts command',
  X_RELEASE_VERSION_SKEW: 'bun run scripts/release.ts --bump patch --dry-run --json',
  // Two real remedies and the command cannot know which one this deployment wants, so it names
  // the one that inspects the binding rather than guessing between a volume and a bucket.
  X_STORAGE_UNWRITABLE: 'x doctor --json',
  X_STORAGE_SECRET_DEV: 'export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"',
  X_MANIFEST_STALE: 'x manifest --json',
  X_BUDGET_UNMEASURED: 'x build --json && x verify --json',
  X_BUILD_FAILED: 'x build --json   # the finding names the failing step',
  X_BUILD_ENTRY_MISSING:
    'x new scratch-app --dry-run --json   # the file list names every entry a build needs',
  X_DEPLOY_FAILED: 'x deploy --json   # the finding carries the command to re-run directly',
  // The container's own environment, so the answer is the run that sets it — never an `x` command,
  // which is not what is running when a `ROLE=wroker` pod refuses to boot.
  X_ROLE_UNKNOWN: 'docker run -e ROLE=web my-app:latest',
  X_PORT_INVALID: 'docker run -e PORT=3000 my-app:latest',
  X_RUNTIME_DRIVER_SPLIT: 'x dev --json   # the boot names the driver the app installed twice',
  X_GENERATE_CONFLICT: 'x g route posts --force --json',
  X_PORT_IN_USE: 'x dev --port 3001 --json',
  // Not `x db status`: there is no such subcommand (`x db` is gen, migrate, reset, studio, branch),
  // so the fix answered a failed step with X_CLI_UNKNOWN_COMMAND. `x doctor` is what reports
  // reachability and drift, and is already this table's answer for X_DB_STUDIO_FAILED.
  X_DB_GEN_FAILED: 'x doctor --json   # cause carries the Postgres error verbatim',
  X_DB_MIGRATE_FAILED: 'x doctor --json   # cause carries the Postgres error verbatim',
  X_DB_BRANCH_FAILED: 'x db branch ls --json',
  X_DB_STUDIO_FAILED: 'x doctor --json',
  X_BOUNDARY_SITE_TO_APP:
    'x verify --json   # then: x fix boundary <the file the finding names> --json',
  X_BOUNDARY_SHARED_LEAF:
    'x verify --json   # then: x fix boundary <the file the finding names> --json',
  X_BOUNDARY_APP_TO_API:
    'x verify --json   # then: x fix boundary <the file the finding names> --json',
  X_BOUNDARY_ROUTE_TO_DB:
    'x verify --json   # then: x fix boundary <the file the finding names> --json',
  X_BOUNDARY_SERVICE_TO_HTTP:
    'x verify --json   # then: x fix boundary <the file the finding names> --json',
  // The app's own guards. All three are reported by the gate and by nothing else, so the runnable
  // half is the gate — the narrowing behind the `#` is the edit, because only the finding knows
  // which file in `guards/` is the one to open.
  X_GUARD_INVALID: 'x verify --json   # then export a `guard` from the file the finding names',
  X_GUARD_FAILED: 'x verify --json   # the cause carries the throw the guard raised, verbatim',
  X_GUARD_FINDING_INVALID:
    'x verify --json   # then give the finding an X_ code, a cause and a fix naming a command',
  // `EDITOR=` inline rather than `export`: the variable is only needed for the one invocation, and
  // an agent copying this line gets a working command instead of a shell it has to keep.
  X_SECRETS_EDITOR_MISSING: 'EDITOR=nano x secrets edit',
  X_SECRETS_EDIT_FAILED: 'x secrets show --json   # then re-open the buffer: x secrets edit',
  // Render's code, thrown here by the bundler half: the cause names the specifier and the file it
  // resolved to, and `x g island` is what puts that file where the page already says it is.
  X_ISLAND_INVALID: 'x routes --json   # the cause names the src; then: x g island <name>',
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
