// What a KILLED run leaves: a mount's directory outlives a process that never reached its dispose,
// its file boundary or its `afterAll` — the gate's step deadline ends a stalled `bun test` with
// SIGKILL. The next process to mount an island sweeps what a dead one left, by its pid.

import { describe, expect, test } from 'bun:test';
// why: Bun has no directory API (mkdtemp, rmdir, utimes) — the sweep under test reads and ages directories
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createScratchDir, removeScratchDir, sweepDeadScratchDirs } from './island-scratch';
import { testName } from './test-types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed instant: the sweep's age rule is asked about mtimes set relative to it, never the clock. */
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

describe(testName('unit', 'a dead process’s island directories are swept'), () => {
  test('a mount’s directory is named by the pid that owns it', () => {
    const dir = createScratchDir();
    try {
      expect(basename(dir)).toMatch(new RegExp(`^ultimate-island-${String(process.pid)}-`));
    } finally {
      removeScratchDir(dir);
    }
  });

  test('only a dead pid’s directory and a day-old unowned one go; everything else stays', () => {
    const root = mkdtempSync(join(tmpdir(), 'island-sweep-root-'));
    try {
      const make = (name: string, mtimeMs: number = NOW): string => {
        const path = join(root, name);
        mkdirSync(path);
        utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
        return path;
      };
      // Liveness is the INJECTED predicate's, so the dead pid is dead by construction: whatever
      // pid this process drew, the other one differs from it.
      const deadPid = process.pid + 1;
      const isAlive = (pid: number): boolean => pid === process.pid;
      const dead = make(`ultimate-island-${String(deadPid)}-abc123`);
      const alive = make(`ultimate-island-${String(process.pid)}-def456`);
      const oldUnowned = make('ultimate-island-Gh7kL2', NOW - 2 * DAY_MS);
      // Just inside the day: the boundary is strict, so this one stays.
      const freshUnowned = make('ultimate-island-Zx9qW1', NOW - DAY_MS + 1_000);
      const states = make('ultimate-island-states-Qw3eR4', NOW - 2 * DAY_MS);
      const stranger = make(`somebody-else-${String(deadPid)}`);

      const swept = sweepDeadScratchDirs(root, isAlive, NOW);

      expect([...swept].sort()).toEqual([dead, oldUnowned].sort());
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(oldUnowned)).toBe(false);
      for (const kept of [alive, freshUnowned, states, stranger])
        expect(existsSync(kept)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
