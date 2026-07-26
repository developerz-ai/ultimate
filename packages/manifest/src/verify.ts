// The contract gate `x verify` runs: a breaking change is allowed, but only with a major
// version bump. This is the enforcement half of `diff.ts` — the diff classifies, this decides.
//
// Enforced, not documented: a convention that isn't a build error doesn't exist.

import type { ManifestDiff } from './diff.ts';
import { diffManifest } from './diff.ts';
import { ManifestBreakingError } from './errors.ts';
import type { Manifest } from './schema.ts';

export interface VerifyContractInput {
  /** The manifest currently committed — the published contract. */
  readonly before: Manifest;
  /** The manifest just built from code. */
  readonly after: Manifest;
}

export interface VerifyContractResult {
  readonly diff: ManifestDiff;
  readonly majorBumped: boolean;
  readonly ok: boolean;
}

/**
 * Classify, then gate. Throws `X_MANIFEST_BREAKING` when the contract broke and the major
 * version did not move; returns the diff otherwise so the caller can print it.
 */
export function verifyContract(input: VerifyContractInput): VerifyContractResult {
  const diff = diffManifest(input.before, input.after);
  const from = majorOf(input.before.app.version);
  const to = majorOf(input.after.app.version);
  // Fail-closed: an unparseable version on EITHER side counts as "not bumped", so a
  // malformed version string can never wave a breaking change through.
  const majorBumped = from >= 0 && to >= 0 && to > from;
  const ok = !diff.hasBreaking || majorBumped;

  if (!ok) {
    throw new ManifestBreakingError({
      changes: diff.breaking.map((c) => `${c.path}: ${c.detail}`),
      from: input.before.app.version,
      to: input.after.app.version,
    });
  }
  return { diff, majorBumped, ok };
}

/** Major component of a semver string, or -1 when it cannot be parsed. */
function majorOf(version: string): number {
  const match = /^(\d+)\./.exec(version.trim());
  if (match === null) return -1;
  return Number.parseInt(match[1] ?? '', 10);
}
