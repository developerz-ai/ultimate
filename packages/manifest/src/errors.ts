// The X_* codes owned by @ultimat3/manifest. `x verify` raises these, so each fix line is a
// command the developer (or the agent) can run verbatim.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const MANIFEST_ERROR_CODES = [
  'X_MANIFEST_DRIFT',
  'X_MANIFEST_BREAKING',
  'X_AGENTS_MD_MISSING',
  'X_AGENTS_MD_TOO_LARGE',
] as const;

export type ManifestErrorCode = (typeof MANIFEST_ERROR_CODES)[number];

export const MANIFEST_ERROR_TITLES: Readonly<Record<ManifestErrorCode, string>> = {
  X_MANIFEST_DRIFT: 'x.manifest.json differs from the code',
  X_MANIFEST_BREAKING: 'a published contract was removed or narrowed',
  X_AGENTS_MD_MISSING: 'no AGENTS.md',
  X_AGENTS_MD_TOO_LARGE: 'AGENTS.md grew past its cap',
};

// Titles must be registered for format() to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(MANIFEST_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

const docsFor = (code: ManifestErrorCode): string => `https://ultimate.dev/errors/${code}`;

/**
 * The committed `x.manifest.json` no longer matches the code. Drift means an agent reading
 * the manifest is reading a description of a program that no longer exists.
 */
export class ManifestDriftError extends UltimateError {
  constructor(input: { path: string; differences: readonly string[] }) {
    super({
      code: 'X_MANIFEST_DRIFT',
      cause: `${input.path} is stale: ${summarize(input.differences)}`,
      fix: 'x manifest',
      docs: docsFor('X_MANIFEST_DRIFT'),
    });
  }
}

/** A breaking contract change landed without a version bump. */
export class ManifestBreakingError extends UltimateError {
  constructor(input: { changes: readonly string[]; from: string; to: string }) {
    super({
      code: 'X_MANIFEST_BREAKING',
      cause:
        `${input.changes.length} breaking change(s) from ${input.from} to ${input.to} ` +
        `with no major version bump: ${summarize(input.changes)}`,
      fix: 'bump the major version in app.config.ts, or restore the removed contract',
      docs: docsFor('X_MANIFEST_BREAKING'),
    });
  }
}

/**
 * `AGENTS.md` is absent. It is hand-written on purpose and is not generated, so the fix is
 * to write one — see the note in `agents-md.ts`.
 */
export class AgentsMdMissingError extends UltimateError {
  constructor(input: { path: string }) {
    super({
      code: 'X_AGENTS_MD_MISSING',
      cause: `${input.path} does not exist`,
      fix: `create ${input.path} by hand: stack, commands, conventions. Keep it short; facts live in x.manifest.json`,
      docs: docsFor('X_AGENTS_MD_MISSING'),
    });
  }
}

/** `AGENTS.md` grew past its budget. A long context file measurably lowers task success. */
export class AgentsMdTooLargeError extends UltimateError {
  constructor(input: { path: string; bytes: number; maxBytes: number }) {
    super({
      code: 'X_AGENTS_MD_TOO_LARGE',
      cause: `${input.path} is ${input.bytes}B, over the ${input.maxBytes}B budget`,
      fix: 'move generated facts out of AGENTS.md and let x.manifest.json carry them',
      docs: docsFor('X_AGENTS_MD_TOO_LARGE'),
    });
  }
}

/** First three items plus a count — a message with 400 entries is a message nobody reads. */
function summarize(items: readonly string[]): string {
  if (items.length <= 3) return items.join('; ');
  return `${items.slice(0, 3).join('; ')} (+${items.length - 3} more)`;
}
