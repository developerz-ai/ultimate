// One `x upgrade` per app at a time: `.x/upgrade.lock`, claimed as `dev-lock.ts` claims `dev.lock`
// (staged, then hard-linked: create and exclusivity are one syscall), its holder named by pid AND
// OS start time (`dev-lock-identity.ts`), so a pid reused after a kill -9 never holds it. Two hops
// over one tree would each write pins and install under the other.

// why: the claim is synchronous link/write/unlink syscalls with no Bun equivalent, kept in one turn.
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { renderFixShellArg, stringField, UltimateError } from '@ultimat3/core';
import { isProcessAlive } from './dev-lock';
import { reusedPid, startedOf } from './dev-lock-identity';
import { stealStale } from './dev-lock-steal';

/** App-root relative, beside the hop's record in the `.x/` every scaffold ignores. */
export const UPGRADE_LOCK_FILE = join('.x', 'upgrade.lock');

interface Holder {
  readonly pid: number;
  readonly startedAt: string;
  /** The holder's OS start time, where the OS reports one; absent in an older CLI's lock. */
  readonly started?: string;
}

const parseHolder = (raw: string | undefined): Holder | undefined => {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; started?: unknown };
    if (typeof value.pid !== 'number') return undefined;
    return {
      pid: value.pid,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
      ...(typeof value.started === 'string' ? { started: value.started } : {}),
    };
  } catch {
    return undefined;
  }
};

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const unwritable = (path: string, error: unknown): UltimateError =>
  new UltimateError({
    code: 'X_UPGRADE_LOCKED',
    cause: `${path} could not be created (${stringField(error, 'code') ?? 'unknown error'}), so this hop cannot prove it is the only one in this app`,
    fix: `ls -ld ${renderFixShellArg(join(path, '..'), '<app>/.x')}   # make it writable by this user, on a filesystem with hard links, then: x upgrade --json`,
  });

/** Create `path` holding `text`, exclusively: `false` when it already exists. */
function claim(path: string, text: string): boolean {
  const staged = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(staged, text);
    linkSync(staged, path);
    return true;
  } catch (error) {
    if (stringField(error, 'code') === 'EEXIST') return false;
    throw unwritable(path, error);
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      // Never written, or already gone: the staging name is unique to this call.
    }
  }
}

export interface LockDeps {
  /** Whether a pid is a live process. */
  readonly alive?: (pid: number) => boolean;
  /**
   * The pid this run records; a test claims as another process. Recorded with no start time, since
   * only this process's own is known: such a lock is judged by its pid alone.
   */
  readonly pid?: number;
}

/**
 * Take the app's upgrade lock, or refuse with `X_UPGRADE_LOCKED` naming the live holder. A lock
 * whose holder is gone — a hop killed hard, its pid dead or reused — is taken over under
 * `stealStale`'s guard. Returns the release, which removes the lock only while it still holds this
 * run's bytes.
 */
export async function acquireUpgradeLock(root: string, deps: LockDeps = {}): Promise<() => void> {
  const alive = deps.alive ?? isProcessAlive;
  const path = join(root, UPGRADE_LOCK_FILE);
  try {
    mkdirSync(join(root, '.x'), { recursive: true });
  } catch (error) {
    throw unwritable(path, error);
  }
  const pid = deps.pid ?? process.pid;
  const identity = deps.pid === undefined ? await startedOf(process.pid) : {};
  const mine = `${JSON.stringify({ pid, startedAt: new Date().toISOString(), ...identity })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (claim(path, mine)) {
      return () => {
        if (readText(path) === mine) unlinkSync(path);
      };
    }
    const raw = readText(path);
    const holder = parseHolder(raw);
    if (holder !== undefined && alive(holder.pid) && !(await reusedPid(holder))) {
      throw new UltimateError({
        code: 'X_UPGRADE_LOCKED',
        cause: `another x upgrade (pid ${String(holder.pid)}, since ${holder.startedAt || 'an unknown time'}) holds ${path}, and two hops in one app would write pins and install under each other`,
        fix: `ps -p ${String(holder.pid)} -o pid,etime,args   # the hop holding the lock: let it finish, or stop it, then: x upgrade --json`,
      });
    }
    // Gone, torn or unreadable: stale. Removed only while it still holds the bytes judged.
    if (
      raw !== undefined &&
      stealStale({ path, judged: raw, claim: (p) => claim(p, mine), alive }) === 'busy'
    ) {
      break;
    }
  }
  throw new UltimateError({
    code: 'X_UPGRADE_LOCKED',
    cause: `${path} is being taken over by another x upgrade right now`,
    fix: `cat ${renderFixShellArg(path, '<app>/.x/upgrade.lock')}   # the pid now holding it; when that process is gone: x upgrade --json`,
  });
}
