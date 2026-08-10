// `x errors explain <CODE>` / `x errors list` — the error table, programmatically. An agent that
// hits an `X_*` code should not have to leave the terminal to learn what it means, and a code it
// invented should come back refused: the answer to an unregistered code is "no such code", never
// a plausible-sounding explanation an agent would then act on.

import type { ErrorExplanation } from '@ultimat3/mcp';
import type { CliCommand, CommandContext } from './command';
import type { ErrorCatalog } from './error-catalog';
import { loadErrorCatalog } from './error-catalog';
import { BadFlagError, ErrorCodeUnknownError } from './errors';
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

function listAll(catalog: ErrorCatalog): CommandResult {
  const all = explainEveryErrorCode();
  return {
    ok: true,
    command: 'errors',
    summary: msg('cli.errors.count', { count: all.length }),
    lines: all.map((entry) => `  ${entry.code.padEnd(30)} ${entry.cause}`),
    data: { codes: all.map(asJson), unavailable: [...catalog.unavailable] },
  };
}

export const errorsCommand: CliCommand = {
  spec: {
    name: 'errors',
    summary: 'an X_* code, explained: cause, runnable fix, docs URL',
    usage: 'x errors [explain <CODE>|list] [--json]',
    subcommands: ERRORS_SUBCOMMANDS,
  },
  // `async` is load-bearing: a synchronous throw would escape every caller that awaits the
  // promise this signature promises, including the dispatcher's own error path.
  async run(ctx: CommandContext): Promise<CommandResult> {
    const catalog = await loadErrorCatalog();
    if (ctx.args.subcommand === 'list') return listAll(catalog);
    const code = ctx.args.positionals[0];
    if (code === undefined) {
      throw new BadFlagError({
        flag: 'code',
        command: 'errors',
        reason: 'x errors explain <CODE> needs a code',
        fix: 'x errors list --json',
      });
    }
    return explainOne(code);
  },
};
