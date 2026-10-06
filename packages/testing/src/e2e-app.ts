// The app an e2e suite drives, spawned on a THROWAWAY state directory: its own embedded database,
// its own disk, its own dev lock, created per call and removed on `stop()`. Never the developer's
// `.x/pgdata` — resetting that from a test run destroys the data an `x dev` beside it is using.
// This file is the DATABASE half; spawning, readiness and the restart are `e2e-spawn.ts`'s.

// why: Bun ships no temp-directory primitive or recursive remove; `tmpdir()` is node:os's alone.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir() — only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — the state dir is joined, not concatenated.
import { join } from 'node:path';
import { finiteCount } from '@ultimat3/core';
import type { E2eAppMode } from './e2e-spawn';
import { E2E_APP_STOP_MS, inherited, READY_PROBE_MS, refuse, spawnE2eApp, xBin } from './e2e-spawn';
import { testSealKeyEnv } from './test-seal-key';

export type { E2eAppMode } from './e2e-spawn';
export { E2E_APP_STOP_MS } from './e2e-spawn';

export interface StartE2eAppOptions {
  /** The app root — the directory holding `app.config.ts`. */
  readonly root: string;
  readonly mode?: E2eAppMode | undefined;
  /**
   * The arguments after `x db seed`, or `false` for no seeding. Default `['--tier', 'dev']`: every
   * dev-tier seed, which is what a developer's own `x dev` starts from.
   */
  readonly seed?: readonly string[] | false | undefined;
  /** Extra environment for every process — the reset, the seed and the app. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** How long the app may take to answer `/readyz`. */
  readonly readyTimeoutMs?: number | undefined;
}

export interface E2eApp {
  /** `http://localhost:<port>`, no trailing slash. */
  readonly base: string;
  /** The throwaway `.x` this app runs on — the one directory a test may inspect or corrupt. */
  readonly stateDir: string;
  /**
   * The last of what the app printed, bounded — what a failing e2e test carries in its message
   * (`failure-context.ts`), so a live-path bug is readable without running `x dev` by hand.
   */
  log(): string;
  /** Kill the app and delete its state directory. Idempotent. */
  stop(): Promise<void>;
  /**
   * Stop the app and start it again on the SAME port and state directory, with `env` added — a
   * deploy. `{ BUILD_ID: 'b2' }` is a new build the open tabs have not seen (`deploy.newBuild()`).
   */
  restart(env?: Readonly<Record<string, string>>): Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;

/** Sequential steps `startE2eApp` bounds at `DEFAULT_READY_TIMEOUT_MS`: `x db reset`, `x db seed`, `/readyz`. */
const START_PHASES = 3;

/**
 * The longest `startE2eApp()` is DESIGNED to take, at its default deadline: the reset, the seed and
 * the readiness wait each given the whole of it, the one probe that may straddle the end, and the
 * bounded stop of an app that never got ready. THE deadline a hook that boots an e2e app derives
 * from — with `E2E_BROWSER_OPEN_MS` beside it when the same hook opens a browser.
 */
export const E2E_APP_START_MS =
  START_PHASES * DEFAULT_READY_TIMEOUT_MS + READY_PROBE_MS + E2E_APP_STOP_MS;

function x(bin: string, args: readonly string[], root: string, env: Record<string, string>): void {
  const run = Bun.spawnSync(['bun', bin, ...args], {
    cwd: root,
    env: { ...inherited(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    // Synchronous inside a test, where the test's own timeout cannot interrupt it: a hung reset is
    // killed here and refused below with what it printed, never a suite that waits forever.
    timeout: DEFAULT_READY_TIMEOUT_MS,
  });
  if (run.exitCode !== 0) {
    throw refuse(`x ${args.join(' ')}`, `${run.stdout.toString()}${run.stderr.toString()}`);
  }
}

/**
 * Reset and seed a fresh state directory, then spawn the app on a free port and wait for `/readyz`.
 * The reset runs against the throwaway directory, so it is a first migration, never a data loss.
 */
export async function startE2eApp(options: StartE2eAppOptions): Promise<E2eApp> {
  // Screened FIRST, before a directory or a process exists: `waited < NaN` is false, so a NaN budget would never poll and report a dead app.
  const deadline = finiteCount(
    'startE2eApp',
    'readyTimeoutMs',
    options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
  );
  // Before the state directory too: an app that cannot name its `x` leaves nothing behind.
  const bin = await xBin(options.root);
  const stateDir = await mkdtemp(join(tmpdir(), 'ultimate-e2e-'));
  // The app is a server, not a test process: it installs no seal key for itself. The harness hands
  // down the throwaway one when the app's root has none, so a `.sealed()` column works under e2e.
  const env: Record<string, string> = {
    ...testSealKeyEnv({ root: options.root }),
    ...options.env,
    ULTIMATE_STATE_DIR: stateDir,
  };
  const cleanup = (): Promise<void> => rm(stateDir, { recursive: true, force: true });
  try {
    x(bin, ['db', 'reset'], options.root, env);
    const seed = options.seed ?? ['--tier', 'dev'];
    if (seed !== false) x(bin, ['db', 'seed', ...seed], options.root, env);
  } catch (error) {
    await cleanup();
    throw error;
  }
  try {
    const spawned = await spawnE2eApp({
      root: options.root,
      mode: options.mode ?? 'dev',
      env,
      bin,
      readyTimeoutMs: deadline,
    });
    return {
      base: spawned.base,
      stateDir,
      log: () => spawned.log(),
      restart: (next) => spawned.restart(next),
      async stop(): Promise<void> {
        await spawned.stop();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
