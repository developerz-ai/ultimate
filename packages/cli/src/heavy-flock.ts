// flock(2) through `bun:ffi`: the one primitive the ledger stands on. The kernel drops the lock when
// the last descriptor closes, which includes the holder dying by any signal, so "the holder died"
// and "the lock is free" are one event and nothing has to detect a stale file.
//
// WINDOWS has no flock, and a Node descriptor there is not the HANDLE `LockFileEx` wants, so the
// ledger is OFF on Windows: `x heavy status` says so and the core cap still applies. An honest gap
// beats a pid file that reintroduces the stale-lock race this module exists to remove.

import { HeavyLedgerUnavailableError } from './heavy-errors';

const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;

const LIBC: Readonly<Record<string, { libs: readonly string[]; errno: string; busy: number }>> = {
  // glibc first; the two musl names are Alpine's, the base of many app images.
  linux: {
    libs: ['libc.so.6', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1'],
    errno: '__errno_location',
    busy: 11,
  },
  darwin: { libs: ['libSystem.B.dylib'], errno: '__error', busy: 35 },
};

/** True when this descriptor now holds the lock, false when another one does. */
export type TryLock = (fd: number) => boolean;

export type FlockBinding =
  | { readonly ok: true; readonly tryLock: TryLock }
  | { readonly ok: false; readonly reason: string };

const bound = new Map<string, Promise<FlockBinding>>();

async function bind(platform: string): Promise<FlockBinding> {
  const spec = Object.hasOwn(LIBC, platform) ? LIBC[platform] : undefined;
  if (spec === undefined) return { ok: false, reason: `flock(2) does not exist on ${platform}` };
  // Imported here so a command that never reaches the ledger never loads FFI.
  const { dlopen, FFIType, read } = await import('bun:ffi');
  for (const lib of spec.libs) {
    try {
      const { symbols } = dlopen(lib, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [spec.errno]: { args: [], returns: FFIType.ptr },
      });
      const errnoAt = symbols[spec.errno] as unknown as () => Parameters<typeof read.i32>[0];
      const flock = symbols.flock as unknown as (fd: number, operation: number) => number;
      return {
        ok: true,
        tryLock: (fd) => {
          if (flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
          const errno = read.i32(errnoAt(), 0);
          if (errno === spec.busy || errno === EINTR) return false;
          // Reading this as "busy" would wait forever on a filesystem that cannot lock at all.
          throw new HeavyLedgerUnavailableError(
            `flock(2) failed with errno ${String(errno)}, which is not contention`,
          );
        },
      };
    } catch {
      // Not this libc: the next name, and "no libc" below when none loads.
    }
  }
  return { ok: false, reason: `no libc with flock(2) loaded (${spec.libs.join(', ')})` };
}

/** The process's one binding, loaded on first use. */
export const flockBinding = (platform: string = process.platform): Promise<FlockBinding> => {
  const known = bound.get(platform);
  if (known !== undefined) return known;
  const binding = bind(platform);
  bound.set(platform, binding);
  return binding;
};
