// One `x upgrade` per app at a time: `.x/upgrade.lock`, claimed the way `dev-lock.ts` claims
// `dev.lock` — written whole to a staging file, then hard-linked into place, so the create and the
// exclusivity are one syscall. Two hops over one tree would each write pins and install under the other.

// why: the claim is synchronous link/write/unlink syscalls with no Bun equivalent, kept in one turn.
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { renderFixShellArg, stringField, UltimateError } from '@ultimat3/core';
import { isProcessAlive } from './dev-lock';
import { stealStale } from './dev-lock-steal';

/** App-root relative, beside the hop's record in the `.x/` every scaffold ignores. */
export const UPGRADE_LOCK_FILE = join('.x', 'upgrade.lock');

interface Holder {
  readonly pid: number;
  readonly startedAt: string;
}

const parseHolder = (raw: string | undefined): Holder | undefined => {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    if (typeof value.pid !== 'number') return undefined;
    return {
      pid: value.pid,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
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
  /** The pid this run records; a test claims as another process. */
  readonly pid?: number;
}

/**
 * Take the app's upgrade lock, or refuse with `X_UPGRADE_LOCKED` naming the live holder. A lock
 * whose holder is gone — a hop killed hard — is taken over under `stealStale`'s guard. Returns the
 * release, which removes the lock only while it still holds this run's bytes.
 */
export function acquireUpgradeLock(root: string, deps: LockDeps = {}): () => void {
  const alive = deps.alive ?? isProcessAlive;
  const path = join(root, UPGRADE_LOCK_FILE);
  try {
    mkdirSync(join(root, '.x'), { recursive: true });
  } catch (error) {
    throw unwritable(path, error);
  }
  const mine = `${JSON.stringify({ pid: deps.pid ?? process.pid, startedAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (claim(path, mine)) {
      return () => {
        if (readText(path) === mine) unlinkSync(path);
      };
    }
    const raw = readText(path);
    const holder = parseHolder(raw);
    if (holder !== undefined && alive(holder.pid)) {
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
