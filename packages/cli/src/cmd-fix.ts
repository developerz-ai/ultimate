// `x fix boundary <file>` — the minimal cut for an import that crossed a surface boundary.
// Analysis and a plan only: it never rewrites a file, and there is no `--write` flag
// (`docs/architecture/02-boundaries.md`) — a caller runs the printed edit, or the generated
// `git mv`, itself.

import { appImportGraph, readAppSources } from './app-boundaries';
import { requireAppRoot } from './app-root';
import type { BoundaryCut } from './boundary-cuts';
import { planBoundaryCuts } from './boundary-cuts';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, FixTargetUnknownError, MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { nearest } from './parse';

export type { BoundaryCut };
export { planBoundaryCuts };

export const FIX_SUBCOMMANDS = ['boundary'] as const;

const docsUrl = (code: string): string => `https://ultimate.dev/errors/${code}`;

/**
 * Accept either an app-root-relative path or a suffix that matches exactly one scanned file —
 * an agent copying the path out of a `fix:` line has the short form
 * (`packages/render/README.md:89` emits exactly that shape).
 */
function resolveTarget(input: string, paths: readonly string[]): string {
  const matches = paths.filter((path) => path === input || path.endsWith(`/${input}`));
  if (matches.length > 1) {
    throw new BadFlagError({
      flag: 'file',
      command: 'fix',
      reason: `"${input}" matches ${matches.length} files: ${matches.join(', ')}`,
    });
  }
  const [only] = matches;
  if (only !== undefined) return only;
  // Compare on the last segment too: a wrong directory is the common miss, and edit distance
  // over the whole path would score every file in the right directory as equally far away.
  const suggestion =
    nearest(input, [...paths]) ??
    paths.find((path) => path.split('/').at(-1) === input.split('/').at(-1));
  throw new FixTargetUnknownError({
    file: input,
    scanned: paths.length,
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

const splitJson = (split: BoundaryCut['split']): JsonValue =>
  split === null
    ? null
    : {
        module: split.module,
        surface: split.surface,
        to: split.to,
        command: split.command,
        importers: split.importers,
        // The human `edit` line names every specifier the move invalidates, so `--json` carries
        // them structured — a plan an agent can apply without re-parsing the sentence.
        edits: split.edits.map((edit) => ({
          file: edit.file,
          imported: edit.imported,
          specifier: edit.specifier,
        })),
      };

const cutJson = (cut: BoundaryCut): JsonValue => ({
  code: cut.code,
  rule: cut.rule,
  entry: cut.entry,
  at: cut.at,
  edge: { from: cut.edge.from, to: cut.edge.to },
  chain: cut.chain,
  edit: cut.edit,
  split: splitJson(cut.split),
});

const findingForCut = (cut: BoundaryCut): Finding => ({
  code: cut.code,
  cause: cut.cause,
  fix: cut.edit,
  docs: docsUrl(cut.code),
  at: cut.at,
});

/** Distinct edges among the cuts — one edit can clear more than one flagged rule at once. */
const editCount = (cuts: readonly BoundaryCut[]): number =>
  new Set(cuts.map((cut) => JSON.stringify([cut.edge.from, cut.edge.to]))).size;

export const fixCommand: CliCommand = {
  spec: {
    name: 'fix',
    // Says "plan" in the one line `x help` prints. The name is kept — five packages' `fix:` lines
    // cite `x fix boundary <file>` and renaming a shipped command breaks every one of them — so
    // the honest move is to stop the summary from promising a repair the command never performs.
    summary: 'plan the minimal cut for an import that crossed a surface boundary (never rewrites)',
    usage: 'x fix boundary <file> [--json]',
    requiresApp: true,
    subcommands: FIX_SUBCOMMANDS,
    defaultSubcommand: 'boundary',
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('fix', ctx.cwd).dir;
    // Refused before the scan, never defaulted to `''`: an empty string reached `resolveTarget` as
    // a file NAME, so a bare `x fix` answered X_FIX_TARGET_UNKNOWN with `"" is not one of the 42
    // source file(s)…` — and `nearest('')` almost never suggests anything, so the fix degraded to
    // `x routes --json` for a caller who had simply not said which file.
    const file = ctx.args.positionals[0];
    if (file === undefined) {
      throw new MissingPositionalError({
        command: 'fix boundary',
        positional: 'file',
        example: 'x routes --json   # every registered route file, app-root-relative',
      });
    }
    const files = await readAppSources(root);
    const target = resolveTarget(
      file,
      files.map((source) => source.path),
    );
    const cuts = planBoundaryCuts(target, appImportGraph(files));

    if (cuts.length === 0) {
      return {
        ok: true,
        command: 'fix',
        summary: msg('cli.fix.clean', { file: target }),
        data: { file: target, cuts: [] },
      };
    }

    return {
      ok: false,
      command: 'fix',
      summary: msg('cli.fix.plan', { count: cuts.length, file: target, edits: editCount(cuts) }),
      findings: cuts.map(findingForCut),
      data: { file: target, cuts: cuts.map(cutJson) },
    };
  },
};
