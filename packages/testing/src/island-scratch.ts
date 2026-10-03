// The island fixture's scratch directories: one per mount, created when the mount needs it and
// removed when the mount ends. A per-PROCESS directory left one behind per `bun test` run, because
// `process.on('exit')` never fires under `bun test` (Bun 1.4.0, measured) — 5,000+ in `/tmp`.

import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = new Set<string>();
let exitHooked = false;

/**
 * A fresh directory for one mount. Fresh, not shared: a module is cached by PATH, so two mounts
 * of byte-identical chunks under one directory imported as ONE instance and shared its state.
 *
 * The `exit` handler is the backstop for a process that is not `bun test` (`bun run`, `x shot`);
 * under `bun test` the file boundary and the run's `afterAll` dispose every mount instead.
 */
export function createScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-island-'));
  live.add(dir);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', removeAllScratchDirs);
  }
  return dir;
}

/** Remove one mount's directory. Idempotent: dispose and a failed mount may both reach it. */
export function removeScratchDir(dir: string): void {
  live.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

function removeAllScratchDirs(): void {
  for (const dir of [...live]) removeScratchDir(dir);
}

/** Every scratch directory whose mount has not ended — read by the leak test. */
export const islandScratchDirs = (): readonly string[] => [...live];
