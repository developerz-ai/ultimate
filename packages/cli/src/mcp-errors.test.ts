// The fix table behind `errors.explain`, held to the contract it exists to keep. A code with no
// command is the failure "errors are instructions" prevents; an `x` command with no `--json` is the
// quieter half of it — the agent that ran a machine-readable command to get here is handed prose.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive, and the fix table's file citations are repo-relative.
import { join } from 'node:path';
import { buildManifest } from '@ultimat3/manifest';
import { checkBudgets } from './budgets';
import { CLI_ERROR_CODES } from './error-codes';
import { staticFix } from './error-contract';
import { citedCommandProblem, loadCommandCatalog } from './fix-command';
import { citedPathProblem } from './fix-path';
import { explainErrorCode, explainEveryErrorCode } from './mcp-errors';

/** This repo's root: the two `bun test <path>` fixes in the table are resolved against it. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * The `x` invocations inside one fix line: `&&` chains are two commands, and the trailing `# …`
 * note is documentation, not argv. `cd myapp` and `bun upgrade` are not the `x` CLI and carry no
 * `--json` — this is the CLI's contract, not a claim about every binary on the machine.
 */
const xCommands = (fix: string): readonly string[] =>
  fix
    .split('&&')
    .map((part) => (part.split('#')[0] ?? '').trim())
    .filter((part) => part.startsWith('x '));

describe('unit · errors.explain', () => {
  test('every CLI code answers with a non-empty command', () => {
    for (const code of CLI_ERROR_CODES) {
      expect(explainErrorCode(code)?.fix ?? '').not.toBe('');
    }
  });

  // `--json` is a GLOBAL_FLAGS flag (axiom 4), so every one of these is runnable as written. A fix
  // that drops it hands the next step's output to a parser that cannot read it.
  test('every `x` command it hands out is machine-readable', () => {
    for (const code of CLI_ERROR_CODES) {
      const fix = explainErrorCode(code)?.fix ?? '';
      for (const command of xCommands(fix)) {
        expect(`${code}: ${command}`).toContain('--json');
      }
    }
  });

  // The quieter half of the same defect: a fix naming a command the registry does not have. This
  // used to read the invocation through `parseArgs`, which is a strictly WEAKER rule than the one
  // every shipped `fix:` literal is held to — a PLANNED command is in the registry and parses, so
  // `x logs tail --json` in this table would have passed here and answered its reader
  // `X_NOT_IMPLEMENTED`, which is the exact defect `fix-command.ts` exists for. The table is a
  // `fix:` in every sense except the key it is written under, so it is judged by the same function.
  test('every `x` command it hands out resolves — planned commands included', async () => {
    const catalog = await loadCommandCatalog();
    const unresolved = CLI_ERROR_CODES.map((code) => {
      const problem = citedCommandProblem(staticFix(explainErrorCode(code)?.fix ?? ''), catalog);
      return problem === undefined ? '' : `${code}: ${problem}`;
    }).filter((line) => line !== '');
    expect(unresolved).toEqual([]);
  });

  // The third rule, for the same reason: two rows hand the reader a `bun test <path>` because the
  // condition can only fire in this repo, and a renamed suite would leave a fix naming nothing.
  test('every file it names is a file this repository has', async () => {
    const missing: string[] = [];
    for (const code of CLI_ERROR_CODES) {
      const problem = await citedPathProblem(
        staticFix(explainErrorCode(code)?.fix ?? ''),
        REPO_ROOT,
      );
      if (problem !== undefined) missing.push(`${code}: ${problem}`);
    }
    expect(missing).toEqual([]);
  });

  // The rule is about the `x` CLI and stops there: `--json` on `bun upgrade` is not a flag, it is a
  // broken command, and a table that "fixed" every row uniformly would ship one.
  test('a fix that runs another tool is left exactly as written', () => {
    expect(explainErrorCode('X_BUN_VERSION')?.fix).toBe('bun upgrade');
    expect(explainErrorCode('X_APP_PACKAGE_INVALID')?.fix).toBe(
      'bun pm pkg set name=my-app version=0.1.0',
    );
  });

  // The `# …` note is why the split above exists: without it the flag lands inside the comment,
  // where a shell never sees it.
  test('a trailing note stays a note, after the flag', () => {
    expect(explainErrorCode('X_SCAFFOLD_PATH_ESCAPE')?.fix).toBe(
      'x g route posts --json   # a path with no ".." segment',
    );
  });

  test('a chained fix carries the flag on both halves', () => {
    expect(explainErrorCode('X_BUDGET_UNMEASURED')?.fix).toBe(
      'x build --target static --json && x verify --json',
    );
    expect(explainErrorCode('X_NOT_IN_APP')?.fix).toBe('x new myapp --json && cd myapp');
  });

  // Two surfaces answer for this one code — `checkBudgets`'s finding and `errors.explain` — and
  // they lived in different modules with different text. Both said `x build`, which defaults to
  // `--target docker` and writes no `.x/build-stats.json`: a fix that runs clean, changes nothing,
  // and hands back the same finding is the failure axiom 4 exists to prevent.
  test('the unmeasured-budget fix names the only target that writes the stats file', () => {
    const manifest = buildManifest({
      app: { name: 'fixture', version: '1.0.0' },
      routes: [{ url: '/pricing', render: 'static', budget: { js: '10kb' } }],
    });
    // `undefined` stats: the state every repo is in until a build runs, and the one this table's
    // single line has to answer for. (The other branch — a build that ran and missed the route —
    // has its own fix, asserted in `budgets.test.ts`.)
    const finding = checkBudgets(manifest, undefined)[0];
    expect(finding?.code).toBe('X_BUDGET_UNMEASURED');
    expect(finding?.fix).toBe(explainErrorCode('X_BUDGET_UNMEASURED')?.fix);
    expect(finding?.fix).toContain('--target static');
  });
});

describe('unit · every fix in the table is a line a shell can run', () => {
  // A `<placeholder>` before the `#` is a REDIRECT, not an argument: `x g route <name>` pasted
  // into bash is `bash: name: No such file or directory`. The runnable part of every fix is
  // everything ahead of the note, so that half may not contain one.
  test('no runnable half carries an angle-bracket placeholder', () => {
    const offenders = explainEveryErrorCode()
      .filter((entry) => CLI_ERROR_CODES.includes(entry.code as (typeof CLI_ERROR_CODES)[number]))
      .filter((entry) => /<[a-zA-Z]/.test(entry.fix.split('#')[0] ?? ''))
      .map((entry) => `${entry.code}: ${entry.fix}`);
    expect(offenders).toEqual([]);
  });

  // A fix that runs clean and changes nothing is the failure axiom 4 exists to prevent: `tsc -b`
  // SKIPS an unreferenced package — that is what the code means — so it exits 0 while the finding
  // stands. The gate is the only run that can show it.
  test('the unreferenced-package fix runs the check that sees it, not the build that skips it', () => {
    const fix = explainErrorCode('X_PACKAGE_UNREFERENCED')?.fix ?? '';
    expect(xCommands(fix)).toEqual(['x verify --json']);
    expect(fix).not.toContain('tsc -b');
  });

  test('the new storage-secret code explains itself with the command that sets the key', () => {
    expect(explainErrorCode('X_STORAGE_SECRET_DEV')?.fix).toBe(
      'export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"',
    );
  });
});
