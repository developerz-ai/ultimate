// Which processes keep a reservation alive: every process with its lock file open, as the OS sees
// it. The ledger records only the wrapper's pid, and after `kill -9` of the wrapper the memory is
// held by the command it started, so a recorded pid cannot say what would free it.

// why: Bun ships no directory listing, readlink or realpath primitive.
import { existsSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { Runner } from './exec';

const PROC = '/proc';

function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // Released while being asked about: nothing will match it, which is the answer.
  }
}

function hasOpen(procRoot: string, pid: string, target: string): boolean {
  const fds = join(procRoot, pid, 'fd');
  try {
    return readdirSync(fds).some((fd) => {
      try {
        return readlinkSync(join(fds, fd)) === target;
      } catch {
        return false; // The descriptor closed between the listing and the read.
      }
    });
  } catch {
    return false; // The process exited, or belongs to another user.
  }
}

const parsePids = (text: string): readonly number[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);

/**
 * The pids with `file` open, this process excepted, or `undefined` when the OS will not say: `/proc`
 * where it exists, `lsof` elsewhere (macOS; Windows has no ledger).
 */
export async function holderPids(
  file: string,
  runner: Runner,
  cwd: string,
  procRoot: string = PROC,
): Promise<readonly number[] | undefined> {
  if (existsSync(join(procRoot, 'self', 'fd'))) {
    const target = realOrSame(file);
    return readdirSync(procRoot)
      .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
      .filter((pid) => hasOpen(procRoot, pid, target))
      .map(Number)
      .sort((a, b) => a - b);
  }
  try {
    // `lsof` exits 1 for "nobody has it open", so its stdout is read whatever the status.
    const result = await runner(['lsof', '-t', file], { cwd });
    return parsePids(result.stdout).filter((pid) => pid !== process.pid);
  } catch {
    return undefined; // No `lsof` on this machine.
  }
}

/** The fallback when no holder list exists. Signal 0 delivers nothing; it only asks. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
