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
import { inherited, refuse, spawnE2eApp, X_BIN } from './e2e-spawn';

export type { E2eAppMode } from './e2e-spawn';

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
  /** Kill the app and delete its state directory. Idempotent. */
  stop(): Promise<void>;
  /**
   * Stop the app and start it again on the SAME port and state directory, with `env` added — a
   * deploy. `{ BUILD_ID: 'b2' }` is a new build the open tabs have not seen (`deploy.newBuild()`).
   */
  restart(env?: Readonly<Record<string, string>>): Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;

function x(args: readonly string[], root: string, env: Record<string, string>): void {
  const run = Bun.spawnSync(['bun', X_BIN, ...args], {
    cwd: root,
    env: { ...inherited(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
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
  const stateDir = await mkdtemp(join(tmpdir(), 'ultimate-e2e-'));
  const env: Record<string, string> = { ...options.env, ULTIMATE_STATE_DIR: stateDir };
  const cleanup = (): Promise<void> => rm(stateDir, { recursive: true, force: true });
  try {
    x(['db', 'reset'], options.root, env);
    const seed = options.seed ?? ['--tier', 'dev'];
    if (seed !== false) x(['db', 'seed', ...seed], options.root, env);
  } catch (error) {
    await cleanup();
    throw error;
  }
  try {
    const spawned = await spawnE2eApp({
      root: options.root,
      mode: options.mode ?? 'dev',
      env,
      readyTimeoutMs: deadline,
    });
    return {
      base: spawned.base,
      stateDir,
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
