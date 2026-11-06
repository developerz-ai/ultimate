// `x new --shape <shape>`: the closed set of app shapes and the one reader of the flag. Apart from
// the templates (`templates/shapes/`) so `cmd-new-spec.ts` can list the names without loading them.

import { UltimateError } from '@ultimat3/core';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import { quoteArg } from './shell-quote';

/** Every shape `x new` writes. A name here and no overlay in `templates/shapes/` fails its test. */
export const NEW_SHAPES = ['api', 'blog', 'dashboard'] as const;

export type NewShape = (typeof NEW_SHAPES)[number];

const isShape = (value: string): value is NewShape =>
  (NEW_SHAPES as readonly string[]).includes(value);

/** `--shape` names nothing `x new` ships. */
export class NewShapeUnknownError extends UltimateError {
  constructor(input: {
    readonly shape: string;
    readonly invocation: string;
    readonly name: string;
  }) {
    super({
      code: 'X_NEW_SHAPE_UNKNOWN',
      cause: `--shape ${quoteArg(input.shape)} is not a shape x new writes; the shapes are ${NEW_SHAPES.join(', ')}`,
      fix: `${input.invocation} ${quoteArg(input.name)} --shape ${NEW_SHAPES[0]}   # every shape: bunx @ultimat3/cli help new`,
    });
  }
}

/** `--shape` with `--no-example`: a shape is its own example, so the pair names two apps. */
export class NewShapeConflictError extends UltimateError {
  constructor(input: {
    readonly shape: NewShape;
    readonly invocation: string;
    readonly name: string;
  }) {
    super({
      code: 'X_NEW_SHAPE_CONFLICT',
      cause: `--shape ${input.shape} and --no-example ask for two different apps: a shape is its own example, and --no-example is the default shape with an empty app/`,
      fix: `${input.invocation} ${quoteArg(input.name)} --shape ${input.shape}`,
    });
  }
}

/**
 * The shape the caller asked for, `undefined` for the default scaffold. Refuses an unknown name and
 * the `--no-example` pairing before anything is planned, so a refusal writes no file.
 */
export function readShape(
  args: ParsedArgs,
  invocation: string,
  name: string,
): NewShape | undefined {
  const raw = flagString(args, 'shape');
  if (raw === undefined) return undefined;
  if (!isShape(raw)) throw new NewShapeUnknownError({ shape: raw, invocation, name });
  if (args.flags.get('example') === false) {
    throw new NewShapeConflictError({ shape: raw, invocation, name });
  }
  return raw;
}
