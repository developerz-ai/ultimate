// TEST-ONLY. A fixture root of this PROCESS's own: `<base>/run-<pid>`. Two processes run one test
// file at once in one checkout (two gate runs, two agents' `bun test`), and on a shared fixed root
// one process's `rm` deleted the other's tree mid-build. Dead processes' roots are reaped here,
// because a crashed run cannot clean up after itself and nothing else knows the directory is stale.

// why: `node:` by necessity, and SYNC by necessity — a fixture root is a module-level `const`,
// and Bun ships neither a directory listing nor a recursive remove of its own.
import { readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { stringField } from '@ultimat3/core';

const RUN = /^run-(\d+)$/;

/**
 * Whether `pid` names a running process. Signal 0 delivers nothing and only asks; `EPERM` is a
 * live process this user may not signal, so only `ESRCH` — no such process — reads as dead.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return stringField(error, 'code') !== 'ESRCH';
  }
}

/** `base`'s entries, or none when no run has created it yet. */
function entriesOf(base: string): readonly string[] {
  try {
    return readdirSync(base);
  } catch (error) {
    if (stringField(error, 'code') === 'ENOENT') return [];
    throw error;
  }
}

/**
 * `<base>/run-<pid>` for this process, after removing every `run-<pid>` sibling whose process has
 * exited. A live one is never touched — that is a peer mid-build — and neither is anything not
 * named `run-<pid>`. A pid reused by an unrelated process keeps its stale root: a leak, never a
 * deletion of something in use.
 */
export function processRoot(base: string): string {
  for (const entry of entriesOf(base)) {
    const pid = Number(RUN.exec(entry)?.[1]);
    // This process's own root is one of the live ones, so it needs no case of its own.
    if (!Number.isInteger(pid) || alive(pid)) continue;
    rmSync(join(base, entry), { recursive: true, force: true });
  }
  return join(base, `run-${String(process.pid)}`);
}
