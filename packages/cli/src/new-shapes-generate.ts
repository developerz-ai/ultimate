// The generators a shape runs once its files are on disk. `x g sign-in` IS how an app gets sign-in —
// its pages, actions, catalog keys, `signInPath` and API registrations land together — so a shape
// that starts signed-in runs it, rather than an overlay re-spelling its output (a second way).

import { renderFixShellArg, UltimateError } from '@ultimat3/core';
import type { CommandContext } from './command';
import type { NewShape } from './new-shapes';
import type { CommandResult, JsonValue } from './output';
import { parseArgs } from './parse';
import { quoteArg } from './shell-quote';

/** A shape's generator refused or failed in the app `x new` just wrote: the framework's bug. */
export class NewShapeGenerateError extends UltimateError {
  constructor(input: {
    readonly shape: NewShape;
    readonly argv: readonly string[];
    readonly target: string;
    readonly result: CommandResult;
  }) {
    const codes = (input.result.findings ?? []).map((finding) => finding.code).join(', ');
    super({
      code: 'X_NEW_SHAPE_GENERATE_FAILED',
      cause: `x new --shape ${input.shape} ran x ${input.argv.join(' ')} in the app it wrote and it failed${codes === '' ? '' : ` (${codes})`}: ${input.result.summary}`,
      // Each word through `quoteArg`: the command is the generator's argv, joined, never a template.
      fix: [
        `cd ${renderFixShellArg(input.target, '<the new app directory>')}`,
        '&&',
        ...['bunx', 'x', ...input.argv, '--json'].map(quoteArg),
        '  # reproduces it; then bun test packages/cli/src/templates/shapes',
      ].join(' '),
    });
  }
}

/**
 * Runs each of `generate` in `target`, in order, through the `x g` command itself, and answers the
 * paths each wrote. The first that fails stops the run: a half-signed-in app is not a shape.
 */
export async function runShapeGenerators(
  ctx: CommandContext,
  shape: NewShape,
  target: string,
  generate: readonly (readonly string[])[],
): Promise<readonly string[]> {
  if (generate.length === 0) return [];
  // Lazy, as the registry loads every command body: `x new` with no shape never pays for `x g`.
  const [{ generateCommand }, { SPECS }] = await Promise.all([
    import('./cmd-generate'),
    import('./registry'),
  ]);
  const written: string[] = [];
  for (const argv of generate) {
    const args = parseArgs(['g', ...argv], SPECS);
    const result = await generateCommand.run({ ...ctx, args, cwd: target });
    if (!result.ok)
      throw new NewShapeGenerateError({ shape, argv: ['g', ...argv], target, result });
    written.push(...filesOf(result));
  }
  return written;
}

/** A JSON object, by its type: `result.data` is the generator's own `JsonValue`, never `unknown`. */
const isJsonObject = (
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const filesOf = (result: CommandResult): readonly string[] => {
  const files = isJsonObject(result.data) ? result.data['files'] : undefined;
  return Array.isArray(files) ? files.filter((file) => typeof file === 'string') : [];
};
