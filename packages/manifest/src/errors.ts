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

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`,
// which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE ROW,
// which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 9.x
// answered 404, host included, on every error it has ever thrown; restating the replacement here
// would be the same constant in eight places waiting to drift again.

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
    });
  }
}

/**
 * Whether this app has ever published a major. NOT `verify.ts`'s `majorOf`, which DECIDES the gate
 * and is fail-closed on an unparseable version; this one only picks which sentence the reader gets,
 * and a version it cannot recognise (`"0"`, `"next"`) falls to the `else` branch — the stricter of
 * the two instructions, so a guess is never the permissive one.
 */
const neverShippedAMajor = (version: string): boolean => version.trim().startsWith('0.');

/**
 * A breaking contract change landed without a version bump.
 *
 * Two causes and two fixes, because the FIRST time this fires it fires in a shape the single
 * message described wrongly, twice over.
 *
 * `from === to` is the guaranteed first-fire shape, not an edge case: the drift gate forces the
 * committed manifest to match the code in any green state, so both sides carry the same
 * `package.json` version and `from 0.1.0 to 0.1.0` reads as a comparison that moved when nothing
 * did. And `x new` scaffolds at `0.1.0`, where the instruction to bump the major is a demand for
 * `1.0.0` from an app with no published clients — `0.2.0` does not satisfy the gate, because
 * `majorOf` compares leading integers only.
 *
 * The file was wrong too: `AppConfig` has no `version` field and `defineConfig` excess-property-
 * checks its literal, so "bump the major version in app.config.ts" fails typecheck when followed
 * literally. The version is read from `package.json` (`app-manifest.ts`).
 */
export class ManifestBreakingError extends UltimateError {
  constructor(input: { changes: readonly string[]; from: string; to: string }) {
    super({
      code: 'X_MANIFEST_BREAKING',
      cause:
        input.from === input.to
          ? `${input.changes.length} breaking change(s) against the committed x.manifest.json, ` +
            `with package.json unchanged at ${input.from}: ${summarize(input.changes)}`
          : `${input.changes.length} breaking change(s) from ${input.from} to ${input.to} ` +
            `with no major version bump: ${summarize(input.changes)}`,
      fix: neverShippedAMajor(input.from)
        ? 'a 0.x app has published no compatibility promise, and only 1.0.0 satisfies this gate — 0.2.0 does not: re-commit the baseline with x manifest, or bun pm pkg set version=1.0.0 in package.json'
        : 'bump the major version in package.json — the leading integer, so 1.4.2 becomes 2.0.0 — or restore the removed contract',
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
    });
  }
}

/** First three items plus a count — a message with 400 entries is a message nobody reads. */
function summarize(items: readonly string[]): string {
  if (items.length <= 3) return items.join('; ');
  return `${items.slice(0, 3).join('; ')} (+${items.length - 3} more)`;
}
