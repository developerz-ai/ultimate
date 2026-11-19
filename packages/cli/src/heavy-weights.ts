// What each heavy command reserves: its MEASURED peak, whole process tree, rounded up to 64 MB. A
// weight is a claim the ledger's bound rests on, so each carries the command that re-reads it, run
// on a clean `git archive` snapshot through `bun run scripts/heavy-peak.ts -- <command>`.
// Measured 2026-11-18, 8 cores / 31 GB, Bun 1.4.4, TypeScript 7.0.2, GOMAXPROCS=RAYON_NUM_THREADS=4.

import { WORKER_BYTES } from './test-workers';

const MIB = 2 ** 20;

/** `tsc -b --pretty false` from cold over this repository's 32 projects: 5,973 MB, 120 s. */
export const TYPECHECK_BUILD_PEAK_MB = 6016;

/** `tsc -p . --pretty false --noEmit` in `examples/dummy`, one program: 763 MB, 8 s. */
export const TYPECHECK_APP_PEAK_MB = 768;

/** `-b` walks every project of a monorepo; `-p .` is the one program of a scaffolded app. */
export const typecheckPeakMb = (argv: readonly string[]): number =>
  argv.includes('-b') ? TYPECHECK_BUILD_PEAK_MB : TYPECHECK_APP_PEAK_MB;

/** `biome check .` at this repository's root: 2,072 MB (1,855 in `examples/dummy`). */
export const LINT_PEAK_MB = 2112;

/**
 * One `bun test` worker: the planner's figure (`WORKER_BYTES`, with its table in `test-workers.ts`).
 * Re-read here: `bun test ./packages/core ./packages/schema ./packages/entity ./packages/action`,
 * one process tree, peaked at 1,229 MB.
 */
export const TEST_WORKER_PEAK_MB = Math.ceil(WORKER_BYTES / MIB);

/**
 * What a test run costs beside its workers: the `x` parent and the first database boot. One worker
 * in `examples/dummy` peaked at 1,915 MB (`x test unit --workers 1`) and 1,964 MB with coverage
 * (`ULTIMATE_HEAVY_CORES=1 x verify --only unit`), which is this plus one worker.
 */
export const TEST_RUN_BASE_MB = 704;

/**
 * `x test e2e` in `examples/dummy`, app server and browser: 2,871 MB. That run ended red on the
 * snapshot, so the figure is a floor and this keeps a margin above it.
 */
export const E2E_LANE_PEAK_MB = 3072;

/** At most this many selected files run free: a worker's own files never queue behind a gate. */
export const FREE_RUN_FILES = 3;

/** `x heavy run` with no `--mb`: an unknown command is assumed to cost a whole-repo typecheck. */
export const DEFAULT_RUN_MB = TYPECHECK_BUILD_PEAK_MB;
