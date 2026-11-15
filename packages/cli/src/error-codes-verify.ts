// The X_* codes of the gate's own floor and run — `x.verify.json`'s ratchets (`steps`, `strict`,
// `skipCeiling`, `coverage`, `guardBaseline`), a step's deadline, the shard/merge split and the
// services a suite needs — split out of `error-codes.ts` at its 500-line ceiling, as
// `error-codes-package.ts` was. That file folds these into the CLI's union and registers them.

/** Codes the gate's floor, its run and its split declare and own. */
export const CLI_VERIFY_ERROR_CODES = [
  // The ratchet's own code. A skipped step is not a failure — unless `x.verify.json` says this
  // repo already ran it, in which case the suite was deleted and the gate would otherwise print
  // one more green line for it.
  'X_VERIFY_SUITE_VANISHED',
  'X_VERIFY_SHARD_INVALID',
  'X_VERIFY_MERGE_INCOMPLETE',
  'X_VERIFY_MERGE_INPUT',
  'X_VERIFY_STEP_TIMEOUT',
  'X_COVERAGE_BELOW_FLOOR',
  'X_COVERAGE_FLOOR_UNSTATED',
  'X_COVERAGE_FLOOR_STALE',
  'X_VERIFY_SKIPS_OVER_CEILING',
  'X_TEST_SERVICES_UNAVAILABLE',
  'X_VERIFY_E2E_BROWSER_MISSING',
  'X_VERIFY_STRICT_UNRUN',
  'X_GUARD_OVER_BASELINE',
  'X_GUARD_BASELINE_STALE',
] as const;

export type CliVerifyErrorCode = (typeof CLI_VERIFY_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_VERIFY_ERROR_TITLES: Readonly<Record<CliVerifyErrorCode, string>> = {
  X_VERIFY_SUITE_VANISHED: 'a step the committed floor requires had nothing left to check',
  X_VERIFY_SHARD_INVALID: 'x verify --shard was given a spec or a step list it cannot split',
  X_VERIFY_MERGE_INCOMPLETE: 'x verify merge was handed parts that do not add up to the whole gate',
  X_VERIFY_MERGE_INPUT: 'a part handed to x verify merge is not an x verify --json document',
  X_VERIFY_STEP_TIMEOUT: 'a gate step ran past its deadline and was stopped',
  X_COVERAGE_BELOW_FLOOR: 'the unit suite covers less of the app than x.verify.json states',
  X_COVERAGE_FLOOR_UNSTATED:
    'x.verify.json states no coverage floor, or one under 95 with no reason',
  X_COVERAGE_FLOOR_STALE: 'the app now covers more than the floor in x.verify.json states',
  X_VERIFY_SKIPS_OVER_CEILING: 'a step skipped more tests than its skipCeiling allows',
  X_TEST_SERVICES_UNAVAILABLE:
    "the live step's test database is not reachable and could not be started",
  X_VERIFY_E2E_BROWSER_MISSING: 'a floored e2e step found no browser to drive',
  X_VERIFY_STRICT_UNRUN: 'x.verify.json is strict and a step ran no check with no written why',
  X_GUARD_OVER_BASELINE: 'a guard reports more findings than its x.verify.json baseline allows',
  X_GUARD_BASELINE_STALE: 'a guard baseline is above what the tree reports',
};
