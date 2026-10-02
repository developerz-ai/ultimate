// The gate's sizing and CI-split refusals: a bad budget env var, an unsplittable `--shard`, and a
// `x verify merge` part that is not a verify document. Split from errors.ts at its size ceiling.

import { UltimateError } from '@ultimat3/core';

/**
 * `ULTIMATE_TEST_MEMORY_BUDGET` or `ULTIMATE_TEST_MAX_WORKERS` set to something that does not
 * parse. Refused rather than ignored: a typo read as "the default" is a run sized for a machine
 * the caller said this is not.
 */
export class TestBudgetInvalidError extends UltimateError {
  constructor(name: string, value: string) {
    super({
      code: 'X_TEST_BUDGET_INVALID',
      cause: `${name}=${JSON.stringify(value)} does not parse — ${
        name === 'ULTIMATE_TEST_MAX_WORKERS'
          ? 'expected a positive integer'
          : 'expected a size such as 3g, 512m or 4GiB'
      }`,
      fix:
        name === 'ULTIMATE_TEST_MAX_WORKERS'
          ? 'ULTIMATE_TEST_MAX_WORKERS=4 x verify'
          : 'ULTIMATE_TEST_MEMORY_BUDGET=3g x verify',
    });
  }
}

/**
 * The gate as an app types it. A refusal raised from another entry — `bun run verify` at the
 * framework root, where `x verify` answers `X_NOT_IN_APP` — passes its own spelling, so the
 * `fix:` runs where it was raised.
 */
const GATE = 'x verify';

/** `x verify --shard` asked for a split the gate cannot make. */
export class VerifyShardInvalidError extends UltimateError {
  constructor(input: { reason: string; fix?: string; command?: string }) {
    const command = input.command ?? GATE;
    super({
      code: 'X_VERIFY_SHARD_INVALID',
      cause: `${command} --shard: ${input.reason}`,
      fix: input.fix ?? `${command} --only unit --shard 1/4 --json`,
    });
  }
}

/** A part handed to `x verify merge` that is not an `x verify --json` document. */
export class VerifyMergeInputError extends UltimateError {
  constructor(input: { file: string; reason: string; sourceError?: unknown; command?: string }) {
    const command = input.command ?? GATE;
    super({
      code: 'X_VERIFY_MERGE_INPUT',
      cause: `${command} merge: ${input.file} ${input.reason}`,
      fix: `${command} --only unit --json > part.json   # one document per part, the last line of stdout`,
      ...(input.sourceError === undefined ? {} : { sourceError: input.sourceError }),
    });
  }
}
