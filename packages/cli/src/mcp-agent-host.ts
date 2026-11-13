// The CLI's answers to `@ultimat3/mcp`'s `DevAgentHost`, each from the command that already owns
// the question: `docs.search` is `x docs`, `db.explain`'s production refusal is `x explain`'s,
// `requests.statements` is `x dev`'s ledger read off its own `/_x/timeline`, and `verify.narrow` is
// `x verify --changed`'s planner asked about one file. Nothing here is a second implementation.

// why: Bun has no path API; an MCP `file` argument may be absolute or `./`-led, the planner reads
// app-relative POSIX paths.
import { relative, resolve } from 'node:path';
import { NotImplementedError, renderFixShellArg, UltimateError } from '@ultimat3/core';
import { docsCommand } from './cmd-docs';
import type { Runner } from './exec';
import { readsAsProduction } from './mcp-db-target';
import type { ParsedArgs } from './parse';
import type { DevServices, Env } from './runtime-bindings';
import { planChangedSteps } from './verify-changed';
import { readChangedFacts } from './verify-changed-facts';
import { VERIFY_STEP_NAMES } from './verify-step';

/**
 * `x explain`'s own rule (`cmd-explain.ts`): an embedded database is always a dev one, an external
 * one is planned only where the environment does not read as production. `db.explain` with
 * `analyze: true` executes the statement, so it inherits the refusal whole — and its code.
 */
export function assertExplainTarget(services: DevServices, env: Env): void {
  if (services.db.mode !== 'external' || !readsAsProduction(env)) return;
  throw new UltimateError({
    code: 'X_EXPLAIN_PRODUCTION_DATABASE',
    cause:
      'DATABASE_URL names an external database and this environment reads as production, where db.explain would plan — and with analyze, run — the statement for real',
    fix: 'env -u DATABASE_URL x mcp serve --transport stdio   # db.explain then plans on the embedded dev database; for production data, a staging restore with ULTIMATE_ENV=staging',
  });
}

/**
 * `x docs <query> --limit <n> --json`, run in this process. The args are built, never parsed:
 * a question that starts with `-` is a question, and `parseArgs` would read it as a flag.
 */
export async function searchDocs(
  ctx: { readonly root: string; readonly env: Env; readonly runner: Runner },
  query: string,
  limit: number,
): Promise<unknown> {
  const args: ParsedArgs = {
    command: 'docs',
    subcommand: undefined,
    positionals: [query],
    flags: new Map([['limit', String(limit)]]),
    json: true,
    help: false,
    passthrough: [],
  };
  const result = await docsCommand.run({
    args,
    cwd: ctx.root,
    env: ctx.env,
    runner: ctx.runner,
    bunVersion: Bun.version,
  });
  return {
    ok: result.ok,
    summary: result.summary,
    data: result.data ?? null,
    findings: result.findings ?? [],
  };
}

const toPosix = (path: string): string => path.split('\\').join('/');

/**
 * What to run after editing `file`: the steps `x verify --changed` would select for it alone, and
 * the narrowest commands that run them. A path outside the app, or one no rule speaks for,
 * selects every step — the planner fails open, and so does this answer.
 */
export async function narrowVerify(root: string, file: string): Promise<unknown> {
  const path = toPosix(relative(resolve(root), resolve(root, file)));
  const plan = planChangedSteps([path], await readChangedFacts(root));
  const rule = plan.files[0]?.rule ?? 'unknown';
  const steps = plan.steps.map((step) => step.name);
  const shown = renderFixShellArg(path, '<file>');
  const whole = steps.length === VERIFY_STEP_NAMES.length;
  const verify = whole ? 'x verify --json' : `x verify --only ${steps.join(',')} --json`;
  // Read off the steps, never off the rule's name: the planner gains rules (`page`), and a test
  // suite among the steps is what says the file's tests are worth running first.
  const tests =
    rule === 'test'
      ? [`x test --filter ${shown} --json`]
      : !whole && steps.includes('unit')
        ? ['x test --affected --dirty --json']
        : [];
  return {
    file: path,
    rule,
    steps,
    // Tests first: they are the fastest red, and the verify line re-runs them inside the gate.
    commands: steps.length === 0 ? [] : [...tests, verify],
    whole: 'x verify --changed --dirty --json',
  };
}

/** `requests.statements` against no running `x dev` — the ledger lives in that process alone. */
export function devNotRunning(): NotImplementedError {
  return new NotImplementedError({
    cause:
      'requests.statements without a running x dev is not implemented in this build: the statement ledger lives in that process',
    fix: 'x dev   # then make the request, and call requests.statements again',
  });
}
