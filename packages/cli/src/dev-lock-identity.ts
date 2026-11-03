// Which process a pid is, beyond the number: its start time, recorded in `.x/dev.lock` beside the
// pid and compared before `x stop` signals. A kill -9 leaves the lock behind and the kernel reuses
// pids, so a pid alone once named an unrelated process for `x stop` to end.

// why: /proc files report size 0, and Bun.file reads a file by its size — it answers ''.
import { readFile } from 'node:fs/promises';
import type { DevLock } from './dev-lock';
import type { Runner } from './exec';
import { exec } from './exec';

/** Field 22 of `/proc/<pid>/stat` (`starttime`), read past the `comm` field, which may hold `)`. */
export function startFromProcStat(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  // Field 3 (`state`) is the first after the comm; `starttime` is field 22, so index 19 from it.
  const start = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return start !== undefined && /^\d+$/.test(start) ? start : undefined;
}

/**
 * The start time of `pid` as the OS reports it, or `undefined` when it will not say (no such
 * process, or Windows, which has no `ps`). Linux reads `/proc`; elsewhere `ps -o lstart=`.
 * Only ever compared for equality with a value this same function wrote.
 */
export async function processStartTime(
  pid: number,
  runner: Runner = exec,
): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return undefined;
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => undefined);
    return stat === undefined ? undefined : startFromProcStat(stat);
  }
  try {
    const ps = await runner(['ps', '-o', 'lstart=', '-p', String(pid)], { cwd: process.cwd() });
    const text = ps.stdout.trim();
    return ps.ok && text !== '' ? text : undefined;
  } catch {
    // `ps` missing is the same answer as a pid it will not describe: no identity to compare.
    return undefined;
  }
}

/**
 * The lock's pid is alive but is not the process that wrote it: its start time differs from the one
 * recorded. Compared only where both are known (no start time on Windows, or in a pre-30 lock).
 */
export const reusedPid = async (lock: DevLock): Promise<boolean> => {
  if (lock.started === undefined) return false;
  const now = await processStartTime(lock.pid);
  return now !== undefined && now !== lock.started;
};

/** `{ started }` for `pid`, or nothing where the OS will not say (Windows). */
export const startedOf = async (pid: number): Promise<{ readonly started?: string }> => {
  const started = await processStartTime(pid);
  return started === undefined ? {} : { started };
};
