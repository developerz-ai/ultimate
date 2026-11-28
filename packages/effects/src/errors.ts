// The X_* codes owned by @ultimat3/effects. Each names the exact change that resolves it.
//
// No `docs:` line, and that is deliberate: `UltimateError`'s constructor resolves the registered
// descriptor, whose default is `ERROR_DOCS_URL` in @ultimat3/core. A URL written out here is a
// second answer to a question core already answers, and the last one went stale host and all.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

// The shape `bun run new-error-code` adds to: the owned array, the TITLES beside it, and the
// registration. A package written another way is refused by that generator, so it is written this
// way from the first file.
export const EFFECTS_ERROR_CODES = [
  // Kept multi-line, a comment holding it open: the generator appends one line per code.
  'X_EFFECTS_INVALID_VALUE',
] as const;

export type EffectsErrorCode = (typeof EFFECTS_ERROR_CODES)[number];

export const EFFECTS_ERROR_TITLES: Readonly<Record<EffectsErrorCode, string>> = {
  X_EFFECTS_INVALID_VALUE: 'effect prop out of range',
};

registerErrorCodes(
  Object.fromEntries(
    Object.entries(EFFECTS_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

/** A prop an effect cannot draw: out of its range, not finite, or not one of its names. */
export class EffectsInvalidValueError extends UltimateError {
  constructor(input: { cause: string; fix: string }) {
    super({ code: 'X_EFFECTS_INVALID_VALUE', cause: input.cause, fix: input.fix });
  }
}
