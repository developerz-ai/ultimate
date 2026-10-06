// The island fixture's scratch directories: one per mount, created when the mount needs it and
// removed when the mount ends. A per-PROCESS directory left one behind per `bun test` run, because
// `process.on('exit')` never fires under `bun test` (Bun 1.4.0, measured) — 5,000+ in `/tmp`. A
// KILLED process reaches no cleanup at all, so each directory carries its owner's pid and the next
// process sweeps a dead owner's.

// why: Bun has no directory API — a scratch DIRECTORY is made, listed, aged and removed, synchronously
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = new Set<string>();
let exitHooked = false;
let swept = false;

const PREFIX = 'ultimate-island-';
/** `ultimate-island-<pid>-<mkdtemp's six>` — this module's own spelling since 2026-10-06. */
const OWNED = /^ultimate-island-(\d+)-[A-Za-z0-9]{6}$/;
/** The spelling before it, with no owner to ask: swept once it is a day old. */
const UNOWNED = /^ultimate-island-[A-Za-z0-9]{6}$/;
const UNOWNED_AGE_MS = 24 * 60 * 60 * 1000;

/** `kill(pid, 0)` delivers nothing and answers whether the pid exists; EPERM is alive. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
};

/**
 * Remove every island directory under `root` whose owning process is gone — the gate's step
 * deadline SIGKILLs a stalled `bun test`, and nothing in a killed process runs. Answers what it
 * removed. Best-effort and silent: a directory another sweeper removed first, or one this user
 * cannot read, is simply not this process's to report.
 */
export function sweepDeadScratchDirs(
  root: string,
  alive: (pid: number) => boolean,
  now: number,
): readonly string[] {
  const removed: string[] = [];
  let names: readonly string[];
  try {
    names = readdirSync(root).filter((name) => name.startsWith(PREFIX));
  } catch {
    return removed;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      const owner = OWNED.exec(name)?.[1];
      const dead =
        owner !== undefined
          ? !alive(Number(owner))
          : UNOWNED.test(name) && now - statSync(path).mtimeMs > UNOWNED_AGE_MS;
      if (!dead) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}

/**
 * A fresh directory for one mount. Fresh, not shared: a module is cached by PATH, so two mounts
 * of byte-identical chunks under one directory imported as ONE instance and shared its state.
 *
 * The `exit` handler is the backstop for a process that is not `bun test` (`bun run`, `x shot`);
 * under `bun test` the file boundary and the run's `afterAll` dispose every mount instead.
 */
export function createScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `${PREFIX}${String(process.pid)}-`));
  // Once per process, at its first mount: the cost is one read of the temp dir. "Now" is the new
  // directory's own mtime — the FILESYSTEM's clock, the one the swept mtimes were written by —
  // never `Date.now()`, which a test process has frozen at whatever instant the suite chose.
  if (!swept) {
    swept = true;
    sweepDeadScratchDirs(tmpdir(), pidAlive, statSync(dir).mtimeMs);
  }
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
