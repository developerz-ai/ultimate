// One exclusive lock file per resource, held by a pid, portable to every host the repo runs on:
// created with `O_EXCL` (`'wx'`), so two processes can never both create it, and taken over only
// when the pid written in it is dead. `flock(1)` did this on Linux alone; macOS and Windows have none.

// why: `'wx'` is the exclusive-create flag; Bun ships no primitive that fails when the file exists.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

export interface LockDeps {
  readonly pid: number;
  /** Whether `pid` is a live process. `process.kill(pid, 0)` in production. */
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  /** Told once, when the first attempt finds the lock held by a live process. */
  readonly onWait?: (holder: number) => void;
  readonly pollMs?: number;
}

/** True when the process exists; EPERM means it exists under another user, ESRCH that it does not. */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
};

const isExists = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';

/** The pid in the file, or undefined for an empty, half-written or vanished file. */
function holderOf(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function tryCreate(path: string, pid: number): boolean {
  try {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error: unknown) {
    if (isExists(error)) return false;
    throw error;
  }
}

/**
 * Wait until this process holds `path`, then answer the release. A file whose holder is dead —
 * or holds no pid at all, a writer killed between create and write — is removed and retried, so a
 * crashed run never wedges the next one. The release removes the file only while it is still ours.
 */
export async function acquireLock(path: string, deps: LockDeps): Promise<() => void> {
  let told = false;
  for (;;) {
    if (tryCreate(path, deps.pid)) break;
    const holder = holderOf(path);
    if (holder === undefined || !deps.isAlive(holder)) {
      try {
        unlinkSync(path);
      } catch {
        // Another waiter removed it first; the next create decides between us.
      }
      continue;
    }
    if (!told) deps.onWait?.(holder);
    told = true;
    await deps.sleep(deps.pollMs ?? 250);
  }
  return () => {
    if (holderOf(path) !== deps.pid) return;
    try {
      unlinkSync(path);
    } catch {
      // Already gone: nothing of ours to remove.
    }
  };
}
