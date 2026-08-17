// `x errors explain <CODE>` / `x errors list` — the error table, programmatically. An agent that
// hits an `X_*` code should not have to leave the terminal to learn what it means, and a code it
// invented should come back refused: the answer to an unregistered code is "no such code", never
// a plausible-sounding explanation an agent would then act on.

import type { ErrorExplanation } from '@ultimat3/mcp';
import type { CliCommand, CommandContext } from './command';
import type { ErrorCatalog } from './error-catalog';
import { loadErrorCatalog } from './error-catalog';
import { loadCodeFixes } from './error-fixes';
import { ErrorCodeUnknownError, MissingPositionalError } from './errors';
import { explainErrorCode, explainEveryErrorCode } from './mcp-errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { nearest } from './parse';

export const ERRORS_SUBCOMMANDS = ['explain', 'list'] as const;

const asJson = (explanation: ErrorExplanation): JsonValue => ({
  code: explanation.code,
  cause: explanation.cause,
  fix: explanation.fix,
  docs: explanation.docs,
});

/** The 3-line contract format, minus the leading blank code line `renderFinding` would add. */
const detailLines = (explanation: ErrorExplanation): readonly string[] => [
  `  cause: ${explanation.cause}`,
  `  fix:   ${explanation.fix}`,
  `  docs:  ${explanation.docs}`,
];

function explainOne(code: string): CommandResult {
  const explanation = explainErrorCode(code);
  if (explanation === undefined) {
    const suggestion = nearest(
      code,
      explainEveryErrorCode().map((entry) => entry.code),
    );
    throw new ErrorCodeUnknownError(suggestion === undefined ? { code } : { code, suggestion });
  }
  return {
    ok: true,
    command: 'errors',
    summary: msg('cli.errors.explained', { code: explanation.code, title: explanation.cause }),
    lines: detailLines(explanation),
    data: asJson(explanation),
  };
}

/**
 * A package that resolved and then threw is a defect, not a host gap: its codes are missing from
 * this answer and something is broken that a `fix:` can address. Reported as findings — and `ok`
 * goes false — so the incomplete catalog cannot read as a complete one.
 */
function listAll(catalog: ErrorCatalog): CommandResult {
  const all = explainEveryErrorCode();
  return {
    ok: catalog.failed.length === 0,
    command: 'errors',
    summary: msg('cli.errors.count', { count: all.length }),
    lines: all.map((entry) => `  ${entry.code.padEnd(30)} ${entry.cause}`),
    findings: catalog.failed,
    data: {
      codes: all.map(asJson),
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
  spec: {
    name: 'errors',
    summary: 'an X_* code, explained: cause, runnable fix, docs URL',
    usage: 'x errors [explain <CODE>|list] [--json]',
    subcommands: ERRORS_SUBCOMMANDS,
    // `explain`, deliberately: the bare `x errors` then answers with `MissingPositionalError`,
    // which names `<CODE>` and hands back a real invocation. `list` would silently print 200 rows
    // to a caller who meant to explain one — see `MissingPositionalError`'s own note.
    defaultSubcommand: 'explain',
  },
  // `async` is load-bearing: a synchronous throw would escape every caller that awaits the
  // promise this signature promises, including the dispatcher's own error path.
  async run(ctx: CommandContext): Promise<CommandResult> {
    // Both loads, always, and before either subcommand branches: the catalog is which codes exist
    // and the fix index is what each one instructs. `x errors list` answering 397 codes with the
    // fallback line would be a complete-looking table of shrugs.
    const [catalog] = await Promise.all([loadErrorCatalog(), loadCodeFixes()]);
    if (ctx.args.subcommand === 'list') return listAll(catalog);
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
    return explainOne(code);
  },
};
