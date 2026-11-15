// `errors.explain`'s rows for the gate's own floor and run — `x.verify.json`'s ratchets, a step's
// deadline, the shard/merge split, the services a suite needs — split out of `mcp-errors.ts` under
// the 500-line ceiling. Spread into `CLI_FIXES` there, whose `Record<CliErrorCode, string>` is still
// what makes a code without a row a build error.

import type { CliErrorCode } from './error-codes';

export const VERIFY_FIXES = {
  // The same two edits `vanishedSuiteFinding` names, verbatim, so both surfaces of this code hand
  // an agent one instruction. Neither edit is scripted here on purpose: a command that rewrites
  // x.verify.json is the gate editing its own ratchet, which is the false green the floor closes.
  X_VERIFY_SUITE_VANISHED:
    'x verify --json   # restore the suite, or drop its name from x.verify.json in the commit that says why',
  X_VERIFY_SHARD_INVALID: 'x verify --only unit --shard 1/4 --json',
  X_VERIFY_MERGE_INCOMPLETE:
    'x verify merge parts/*.json --json   # after every CI job uploaded its part',
  X_VERIFY_MERGE_INPUT: 'x verify --only unit --json > part.json   # one document per part',
  X_VERIFY_STEP_TIMEOUT:
    'x verify --only unit --json   # reproduce the step alone; one that needs longer states it under "stepTimeoutMs" in x.verify.json',
  X_COVERAGE_BELOW_FLOOR:
    'x verify --only unit --json   # names the ten files losing the most lines; cover the worst with a test beside it',
  X_COVERAGE_FLOOR_UNSTATED:
    'x verify --only unit --json   # the finding carries the measured numbers and the "coverage" line to add to x.verify.json',
  X_COVERAGE_FLOOR_STALE:
    'x verify --only unit --json   # the finding carries the measured numbers; raise "coverage" in x.verify.json to them',
  X_VERIFY_SKIPS_OVER_CEILING:
    'x test unit --json   # then set what the skipped tests need, or raise skipCeiling in x.verify.json with the reason in the diff',
  X_TEST_SERVICES_UNAVAILABLE: 'docker compose -f docker/docker-compose.test.yml up -d --wait',
  X_VERIFY_E2E_BROWSER_MISSING:
    'curl -fsSLo /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt-get install -y /tmp/google-chrome.deb',
  X_VERIFY_STRICT_UNRUN:
    'x verify --json   # data.skipReasons names each step that ran no check: give it a suite, or write "skip": { "<step>": "<why>" } in x.verify.json',
  X_GUARD_OVER_BASELINE: 'x verify --only boundaries --json',
  X_GUARD_BASELINE_STALE: 'x verify --only boundaries --json',
} as const satisfies Partial<Record<CliErrorCode, string>>;
