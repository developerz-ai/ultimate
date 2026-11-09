#!/usr/bin/env bun
// `bun run typecheck:locked`: `tsc -b` under one repo-wide lock. Agents share one checkout, and two
// unserialised `tsc -b` runs write the same `.tsbuildinfo` and `dist/` and report errors that
// belong to neither. Portable where `flock(1)` was Linux-only (`scripts/lib/file-lock.ts`).
//
//   bun run typecheck:locked

// why: one lock-file path under the repo root; Bun ships no path API.
import { join } from 'node:path';
import { acquireLock, pidAlive } from './lib/file-lock';
import { localBin } from './lib/local-bin';
import { repoRoot } from './lib/run';

/** Under `node_modules/.cache`: ignored by git, and gone with the install it guards. */
export const TSC_LOCK = join('node_modules', '.cache', 'tsc.lock');

/** A full `tsc -b` from cold is minutes; a run past this has hung, and its lock must not wedge. */
const TSC_TIMEOUT_MS = 30 * 60_000;

if (import.meta.main) {
  const root = repoRoot();
  const path = join(root, TSC_LOCK);
  await Bun.write(join(root, 'node_modules', '.cache', '.keep'), '');
  const release = await acquireLock(path, {
    pid: process.pid,
    isAlive: pidAlive,
    sleep: (ms) => Bun.sleep(ms),
    onWait: (holder) => console.error(`typecheck:locked: waiting on pid ${holder} (${TSC_LOCK})`),
  });
  // An interrupted run gives the lock back rather than leaving the next one to prove it dead.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      release();
      process.exit(130);
    });
  }
  try {
    const child = Bun.spawn([localBin(root, 'tsc'), '-b', '--pretty'], {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
      timeout: TSC_TIMEOUT_MS,
    });
    process.exitCode = await child.exited;
  } finally {
    release();
  }
}
