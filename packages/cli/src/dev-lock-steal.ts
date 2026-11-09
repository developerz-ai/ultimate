// `x dev`'s stale-lock removal, under an exclusive guard: only the boot holding `dev.lock.steal`
// may delete the lock, and only while it still holds the bytes that boot judged stale. An unlink by
// path after an unguarded read deleted whatever was there by then, a rival's fresh claim included,
// so two boots over one stale lock both won.

// why: the guard and the take are synchronous syscalls (link, rename, unlink, stat) with no Bun
// equivalent, and a sync read keeps the check and the act in one turn of the event loop.
import { linkSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';

/**
 * `cleared`: the lock judged stale is gone, so the claim may be retried. `changed`: the lock there
 * now is not the one judged, because another boot cleared it and claimed, so judge again.
 * `busy`: another boot is clearing it right now.
 */
export type StealOutcome = 'cleared' | 'changed' | 'busy';

/** The guard's suffix: `dev.lock.steal`, beside the lock it guards. */
export const STEAL_GUARD_SUFFIX = '.steal';

/**
 * Past this age a guard is a crashed steal, whatever its pid says: the steal is three syscalls, and
 * a pid the kernel reused would otherwise hold every later steal off forever.
 */
export const STEAL_GUARD_STALE_MS = 10_000;

export interface StealInput {
  /** The lock file. */
  readonly path: string;
  /** The lock's bytes as the caller read them and found them stale. */
  readonly judged: string;
  /** Create `path` exclusively, holding this process's lock record; `false` when it exists. */
  readonly claim: (path: string) => boolean;
  /** Whether a pid is a live process: the guard's holder is always a real one. */
  readonly alive: (pid: number) => boolean;
  /** Test seam for the guard's age. */
  readonly now?: () => number;
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const discard = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone. Each caller below has already decided the file is its own to remove.
  }
};

/**
 * Remove `path` only if it still holds `judged`: renamed to a name unique to this call (one
 * syscall, so of two boots exactly one gets the file), then compared, and linked back when it is
 * not the one judged. Linked, never renamed back: a rename would overwrite a claim made meanwhile.
 * `true` when the file judged is gone.
 */
function takeAway(path: string, judged: string): boolean {
  const taken = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.stale`;
  try {
    renameSync(path, taken);
  } catch {
    return true;
  }
  const found = readText(taken);
  if (found !== judged) {
    try {
      linkSync(taken, path);
    } catch {
      // A claim landed on the emptied name in that instant; it is the one that stands.
    }
  }
  discard(taken);
  return found === judged;
}

/** A guard left by a steal that never finished: its pid is gone, it is too old, or unreadable. */
function guardAbandoned(guard: string, held: string, input: StealInput): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(held) as { pid?: unknown }).pid;
  } catch {
    return true;
  }
  if (typeof pid !== 'number' || !input.alive(pid)) return true;
  try {
    return (input.now ?? Date.now)() - statSync(guard).mtimeMs > STEAL_GUARD_STALE_MS;
  } catch {
    return false;
  }
}

function takeGuard(guard: string, input: StealInput): boolean {
  if (input.claim(guard)) return true;
  const held = readText(guard);
  // Released between the claim and the read: the steal it guarded is over, so ask once more.
  if (held === undefined) return input.claim(guard);
  if (!guardAbandoned(guard, held, input)) return false;
  // Two boots may both judge one guard abandoned: `takeAway` lets only the one that still finds
  // THOSE bytes remove it, so the second never deletes the first's fresh guard.
  return takeAway(guard, held) && input.claim(guard);
}

/**
 * Delete the lock at `input.path` if it still holds `input.judged`, holding the guard throughout.
 * Under the guard the check-then-act is safe: a lock that exists is removed only by the guard's
 * holder, and its stale owner writes nothing, so the bytes read are the bytes unlinked.
 */
export function stealStale(input: StealInput): StealOutcome {
  const guard = `${input.path}${STEAL_GUARD_SUFFIX}`;
  if (!takeGuard(guard, input)) return 'busy';
  try {
    const found = readText(input.path);
    if (found === undefined) return 'cleared';
    if (found !== input.judged) return 'changed';
    discard(input.path);
    return 'cleared';
  } finally {
    discard(guard);
  }
}
