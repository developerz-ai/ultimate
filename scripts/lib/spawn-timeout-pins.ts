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
      "why: `exec.ts` is the CLI subprocess boundary — its deadline is the caller's: `x verify` ends a step's whole tree in `verify-deadline.ts` (`X_VERIFY_STEP_TIMEOUT`). `local-cli-handoff.ts` spawns the app's own CLI with the user's argv, forwards its stop signals and answers its exit code, and `bin.ts` exits with that code, so its lifetime is the command the user typed. `dev-supervisor.ts` runs `x dev`'s server until Ctrl-C. `cmd-secrets.ts` opens `$EDITOR` on a terminal and waits for the human to close it.",
  },
  // why: two long-lived children each with its own stop path. Chrome's launch left this row in
  // 31.0.0: it moved to `@ultimat3/scraping/cdp`, and its spawn carries `timeout: lifetimeMs`.
  testing: {
    count: 2,
    reason:
      "why: `e2e-spawn.ts` starts the app under test, which serves until `stop()` kills it; readiness is bounded by `DEFAULT_READY_TIMEOUT_MS`. `drill-fleet.ts`'s `spawnRole` starts each role of a drill's fleet, which serves until the fleet's `stop()` SIGKILLs every child it holds (on a failed start too); readiness and the `ROLE=migrate` run are bounded by `readyTimeoutMs`, a drain by `exitWithin`.",
  },
  // why: four children killed by the script that started them, and one bounded by test timeouts.
  // `lib/run.ts` left this row in #780: its own deadline (`DEFAULT_RUN_TIMEOUT_MS`) now ends a child.
  // Raised 4→5 by `bench/http-hello.ts`'s `coldStart`: a server the bench measures, which must
  // outlive any fixed timeout, ended by the `stop()` that signals its process group.
  scripts: {
    count: 3,
    reason:
      "why: `coverage-gate.ts` runs one `bun test --coverage` per unit, bounded by each test's own timeout and the CI job's; SUSPECT, the one row a hang could still outlast locally. `scaffold-admin.ts` boots `x dev` and kills it in its `finally`; `bench/restart-bench.ts` starts a server and its client shards and kills both when the run ends; `bench/http-hello.ts`'s `coldStart` boots the server under measurement and `stop()` SIGTERMs its process group, on a failed start too.",
  },
};
