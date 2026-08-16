// Single responsibility: bounding how many argon2 hashes this process runs at once.
//
// WHY it is not covered by the limiters that already exist: `rate-limit.ts`'s `ipKey(ip)` and
// `@ultimat3/http`'s `auth` bucket are both keyed by SOURCE, so an attacker rotating an IPv6 /64
// mints a fresh key per attempt and is never throttled by either; and both cap ATTEMPTS, while
// what argon2id costs is MEMORY — 19 MiB per hash at the OWASP floor. The only remaining backstop
// was `http.maxInflight` (1000), i.e. roughly 19 GB of arenas queued on one box.

import { kdfOverloaded } from './errors';

export interface KdfLimits {
  /** Hashes running at once. Multiply by `memoryCost` for the resident ceiling this buys. */
  readonly maxConcurrent: number;
  /** Callers allowed to WAIT for a slot. Past this the answer is a refusal, not a longer queue. */
  readonly maxQueued: number;
}

/**
 * 8 x 19 MiB is ~152 MiB resident, which fits the smallest box anyone runs a web role on, and 64
 * waiters is about two seconds of backlog at that width — long enough to absorb a burst of real
 * logins, short enough that a spray is refused while the process is still answering.
 */
export const DEFAULT_KDF_LIMITS: KdfLimits = Object.freeze({ maxConcurrent: 8, maxQueued: 64 });

export interface KdfGate {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * A slot is HANDED OVER on release rather than released and re-acquired: decrementing first would
 * let a caller arriving in the same tick past the ceiling while a waiter's continuation is still
 * a queued microtask, which is how a "bounded" pool goes over its bound under exactly the load it
 * exists for.
 */
export function createKdfGate(limits: KdfLimits = DEFAULT_KDF_LIMITS): KdfGate {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < limits.maxConcurrent) {
      active += 1;
      return;
    }
    if (waiters.length >= limits.maxQueued) throw kdfOverloaded(active, waiters.length);
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next === undefined) active -= 1;
    else next();
  };

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

let gate = createKdfGate();

/** The process-wide gate every `hashPassword`/`verifyPassword` passes through. */
export const kdfGate = (): KdfGate => gate;

/**
 * The ONE install point, the same shape as `configureCursorSigning` in `@ultimat3/core`: a box
 * with more memory may widen the ceiling, and a test needs a narrow one. Not a `defineAuth` key,
 * because this is a property of the MACHINE, not of the app's auth policy — the same app config
 * runs on a 512 MiB PaaS dyno and a 64 GiB node.
 */
export function configureKdfGate(limits: KdfLimits): void {
  gate = createKdfGate(limits);
}

/** Back to the shipped defaults. Tests that call `configureKdfGate` must call this in cleanup. */
export function resetKdfGate(): void {
  gate = createKdfGate();
}
