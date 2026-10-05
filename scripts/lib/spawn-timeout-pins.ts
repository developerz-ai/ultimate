// The ratchet under `scripts/spawn-timeout.ts`: how many child processes each package spawns with
// no `timeout` and no abort `signal`. A count may FALL and never rise without a `why:` saying who
// ends the child instead. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/spawn-timeout.ts --unpin <pkg>[,<pkg>]`.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const SPAWN_TIMEOUT_PINS_FILE = 'scripts/lib/spawn-timeout-pins.ts';

export interface SpawnTimeoutPin {
  readonly count: number;
  /** Who ends each untimed child, by name — never "it exits". */
  readonly reason: string;
}

/**
 * Measured 2026-10-03, on the rule's first run, after the five synchronous sites and the two `ps`
 * listings it found had a timeout added (`sitemap-lastmod.ts`, `dev-live-fixture.ts`,
 * `verify-deadline.ts`, `e2e-app.ts`, `build-icons.ts`). What is left lives as long as a person or
 * a caller-held deadline says, by design.
 */
export const SPAWN_TIMEOUT_PINS: Readonly<Record<string, SpawnTimeoutPin>> = {
  // why: four children whose lifetime is a human's or a caller's, never a number this file knows.
  cli: {
    count: 4,
    reason:
      "why: `exec.ts` is the CLI subprocess boundary — its deadline is the caller's: `x verify` ends a step's whole tree in `verify-deadline.ts` (`X_VERIFY_STEP_TIMEOUT`). `local-cli-handoff.ts` (from `bin.ts`) forwards argv and signals to the app's own CLI and exits with it, so its lifetime is the command the user typed. `dev-supervisor.ts` runs `x dev`'s server until Ctrl-C. `cmd-secrets.ts` opens `$EDITOR` on a terminal and waits for the human to close it.",
  },
  // why: two long-lived children each with its own stop path.
  testing: {
    count: 2,
    reason:
      "why: `e2e-spawn.ts` starts the app under test, which serves until `stop()` kills it; readiness is bounded by `DEFAULT_READY_TIMEOUT_MS`. `cdp-launch-attempt.ts` starts Chrome, which exits when its command pipe (fd 3) closes, and the launch is bounded by the attempt's own deadline.",
  },
  // why: the gate's own boundary plus three children killed by the script that started them.
  scripts: {
    count: 5,
    reason:
      "why: `lib/run.ts` is the root scripts' subprocess boundary — `x verify`'s per-step deadline and CI's job timeout bound what runs through it. `coverage-gate.ts` runs one `bun test --coverage` per unit, bounded by each test's own timeout and the CI job's; SUSPECT, the one row a hang could still outlast locally. `scaffold-admin.ts` boots `x dev` and kills it in its `finally`; `bench/restart-bench.ts` starts a server and its client shards and kills both when the run ends.",
  },
};
