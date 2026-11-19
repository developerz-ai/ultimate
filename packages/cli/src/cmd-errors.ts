// `x errors explain <CODE>` / `x errors list` — the error table, programmatically. An agent that
// hits an `X_*` code should not have to leave the terminal to learn what it means, and a code it
// invented should come back refused: "no such code", never a plausible-sounding explanation.

import { nearestName, singleLine } from '@ultimat3/core';
import { definedErrorStatus } from '@ultimat3/core/internal/error-status';
import type { ErrorExplanation } from '@ultimat3/mcp';
import { findAppRoot } from './app-root';
import { type AppCodeExplanation, AppCodeUnknownError, explainAppCode } from './cmd-errors-app';
import { explainGuardCode } from './cmd-errors-guards';
import { withRecent } from './cmd-errors-recent';
import { errorsSpec } from './cmd-errors-spec';
import type { CliCommand, CommandContext } from './command';
import type { ErrorCatalog } from './error-catalog';
import { loadErrorCatalog } from './error-catalog';
import { codeFixes, loadCodeFixes } from './error-fixes';
import { ErrorCodeUnknownError, MissingPositionalError } from './errors';
import { explainErrorCode, explainEveryErrorCode } from './mcp-errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { ReaderOptions } from './output-findings';
import { fixForReader } from './output-findings';
import { flagBool } from './parse';

export { ERRORS_SUBCOMMANDS } from './cmd-errors-spec';

/**
 * `site` is the throw site as DATA, and it is why the `fix:` for a code whose fix is built at run
 * time does not have to pretend to be a command. For those codes the location IS the answer, and a
 * caller that has to regex `packages/x/src/y.ts:80` back out of an English sentence is a caller the
 * machine-readable surface failed. `null` when the installed framework raises the code nowhere.
 */
const asJson = (explanation: ErrorExplanation, reader?: ReaderOptions): JsonValue => {
  const site = codeFixes().get(explanation.code)?.[0];
  return {
    code: explanation.code,
    cause: explanation.cause,
    fix: fixForReader(explanation.fix, reader),
    docs: explanation.docs,
    site: site === undefined ? null : { at: site.at, line: site.line },
  };
};

/** The 3-line contract format, minus the leading blank code line `renderFinding` would add. */
const detailLines = (explanation: ErrorExplanation, reader?: ReaderOptions): readonly string[] => [
  `  cause: ${singleLine(explanation.cause)}`,
  `  fix:   ${singleLine(fixForReader(explanation.fix, reader))}`,
  `  docs:  ${singleLine(explanation.docs)}`,
];

/**
 * A registered code, else a guard's — a shipped guard's or this app's own (`cmd-errors-guards.ts`):
 * the gate prints both, and the app's `CLAUDE.md` sends every printed code here.
 */
async function explainOne(
  code: string,
  cwd: string,
  reader?: ReaderOptions,
): Promise<CommandResult> {
  // A `defineError()` code is an app's, even once this process has loaded the app (`x mcp serve`, a
  // test rerun): the registry then knows it, and it was answered as a framework code with no throw
  // site in the installed framework, never from the app that declares it.
  const appDeclared = definedErrorStatus(code) !== undefined;
  const explanation = appDeclared
    ? undefined
    : (explainErrorCode(code) ?? (await explainGuardCode(code, cwd)));
  if (explanation === undefined) {
    // Before the app loads, so the near miss is a framework code the caller mistyped.
    const suggestion = nearestName(
      code,
      explainEveryErrorCode().map((entry) => entry.code),
    );
    const declared = await explainAppCode(code, cwd);
    if (declared !== undefined) return appCodeResult(declared);
    if (suggestion !== undefined) throw new ErrorCodeUnknownError({ code, suggestion });
    throw new AppCodeUnknownError({ code, inApp: findAppRoot(cwd) !== undefined });
  }
  return {
    ok: true,
    command: 'errors',
    summary: msg('cli.errors.explained', { code: explanation.code, title: explanation.cause }),
    lines: detailLines(explanation, reader),
    data: asJson(explanation, reader),
  };
}

/**
 * An app's own code: what the registry holds (title, status) and the declaring line. No `cause:` or
 * `fix:` line — the registry keeps neither for a `defineError` code, and the declaration is one open
 * file away.
 */
const appCodeResult = (declared: AppCodeExplanation): CommandResult => ({
  ok: true,
  command: 'errors',
  summary: msg('cli.errors.explained', { code: declared.code, title: declared.title }),
  lines: [
    `  status:   ${declared.status ?? 'off-socket'}`,
    ...(declared.site === null ? [] : [`  declared: ${declared.site.at}:${declared.site.line}`]),
    `  docs:     ${singleLine(declared.docs)}`,
  ],
  data: { ...declared },
});

/**
 * A package that resolved and then threw is a defect, not a host gap: its codes are missing from
 * this answer and something is broken that a `fix:` can address. Reported as findings — and `ok`
 * goes false — so the incomplete catalog cannot read as a complete one.
 */
function listAll(catalog: ErrorCatalog, reader?: ReaderOptions): CommandResult {
  const all = explainEveryErrorCode();
  return {
    ok: catalog.failed.length === 0,
    command: 'errors',
    summary: msg('cli.errors.count', { count: all.length }),
    lines: all.map((entry) => `  ${entry.code.padEnd(30)} ${singleLine(entry.cause)}`),
    findings: catalog.failed,
    data: {
      codes: all.map((entry) => asJson(entry, reader)),
      unavailable: [...catalog.unavailable],
      failed: catalog.failed.map((finding) => ({
        code: finding.code,
        cause: finding.cause,
        fix: finding.fix,
        at: finding.at ?? null,
      })),
    },
  };
}

export const errorsCommand: CliCommand = {
  spec: errorsSpec,
  // `async` is load-bearing: a synchronous throw would escape every caller that awaits the
  // promise this signature promises, including the dispatcher's own error path.
  async run(ctx: CommandContext): Promise<CommandResult> {
    // Both loads, always, and before either subcommand branches: the catalog is which codes exist
    // and the fix index is what each one instructs. `x errors list` answering 397 codes with the
    // fallback line would be a complete-looking table of shrugs.
    const [catalog] = await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
    if (ctx.args.subcommand === 'list') return listAll(catalog, ctx.reader);
    const code = ctx.args.positionals[0];
    if (code === undefined) {
      // Not a `BadFlagError`: naming `--code` invented a flag that does not exist, so an agent
      // reading the cause literally tried `x errors --code X_DB_DRIFT` and got a SECOND
      // X_CLI_BAD_FLAG for an unknown flag.
      throw new MissingPositionalError({
        command: 'errors explain',
        positional: 'CODE',
        example: 'x errors list --json',
      });
    }
    // `--recent`: what THIS app has seen of the code — groups and the bundles `x repro` replays.
    if (flagBool(ctx.args, 'recent')) {
      return withRecent(ctx, code, await explainOne(code, ctx.cwd, ctx.reader));
    }
    return explainOne(code, ctx.cwd, ctx.reader);
  },
};
