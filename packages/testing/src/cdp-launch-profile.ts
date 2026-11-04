// One responsibility: the throwaway profile a launch hands Chrome, its removal — after every
// process of the browser is gone, retried while something re-creates it, bounded — together with
// the singleton-socket directory Chrome makes BESIDE it, and the TEMP ROOT both the profile and
// the browser's own `$TMPDIR` sit under, kept short enough for Chrome's socket path.

// why: Bun exposes no temp-root, recursive-remove or readlink primitive; the profile needs all three.
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { basename, dirname, join } from 'node:path';

/**
 * How long a removed profile is watched for coming back before it counts as gone. Chrome's late
 * writers are the network service flushing its disk cache and the browser's atomic preference
 * write (`Default/.com.google.Chrome.XXXXXX`) — the exact tree the leaked profiles held. Removal
 * waits for the process tree first, so the look is for what the tree kill cannot see: a process
 * outside the group (Chrome's crashpad handler calls `setsid`), and on Windows a child `taskkill`
 * has not finished ending when it returns.
 */
export const PROFILE_SETTLE_MS = 50;

/**
 * What Chrome's ProcessSingleton puts in its socket directory, and nothing else. The directory is
 * `<temp>/com.google.Chrome.XXXXXX` (Chromium: `org.chromium.Chromium.…`), linked from the profile's
 * `SingletonSocket`, and a browser that does not shut down cleanly never removes it: measured, one
 * left in the temp root per launch — 444 of them beside 146 leaked profiles.
 */
const SINGLETON_FILES: ReadonlySet<string> = new Set([
  'SingletonSocket',
  'SingletonCookie',
  'SingletonLock',
]);

export interface ThrowawayProfile {
  readonly path: string;
  /**
   * Where the browser's singleton socket lives, read off the profile's own link. Asked BEFORE the
   * browser is signalled: a browser that exits cleanly removes the link first, and one killed
   * leaves the directory with nothing in the profile pointing at it.
   */
  singletonDir(): string | undefined;
  /**
   * Remove the profile — and `singleton`, when it holds Chrome's singleton files and nothing else —
   * and answer once neither has come back for `settleMs` (`PROFILE_SETTLE_MS`), or at `deadlineMs`.
   * Never throws: a directory that will not go is litter, never the close's verdict.
   */
  remove(singleton: string | undefined, deadlineMs: number, settleMs?: number): Promise<void>;
}

const quietly = (work: () => void): void => {
  try {
    work();
  } catch {
    // Already gone, or held open past the deadline: the loop's next look decides which.
  }
};

/**
 * Only a directory whose every entry is a singleton file is Chrome's to have made: a link that
 * points anywhere else is somebody's directory, and is left alone.
 */
function isSingletonDir(dir: string): boolean {
  try {
    return readdirSync(dir).every((entry) => SINGLETON_FILES.has(entry));
  } catch {
    return false;
  }
}

/** File by file, then a plain `rmdir` — never a recursive remove of a path read off a link. */
function removeSingleton(dir: string): void {
  for (const entry of SINGLETON_FILES) quietly(() => rmSync(join(dir, entry), { force: true }));
  quietly(() => rmdirSync(dir));
}

/**
 * How long a unix socket path may be. Chrome's ProcessSingleton puts its socket at
 * `$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket` and the kernel refuses one longer than this:
 * Chrome answers `FATAL:process_singleton_posix.cc:315] Socket path too long` and exits, so the
 * launch dies as `X_CDP_LAUNCH_FAILED` with a cause that names the browser and not the reason.
 *
 * The length is of the CHROME process's own `$TMPDIR` — not of the profile's directory, which may
 * live anywhere — so what has to fit is the temp root the browser is started with.
 */
export const SOCKET_PATH_LIMIT = 108;

/**
 * What the browser leaves of that limit: Chrome's own directory name and its socket file name.
 * The longer of the two paths the browser builds under the temp root — the socket directory it
 * makes in `$TMPDIR`, and the profile's own `SingletonSocket` link — decides.
 */
const SOCKET_PATH_RESERVE = Math.max(
  'com.google.Chrome.XXXXXX/SingletonSocket'.length,
  'x-e2e-chrome-XXXXXX/SingletonSocket'.length,
);

/**
 * The temp root a browser and its profile are made under: the one asked for, unless the paths it
 * implies would leave Chrome's socket no room.
 *
 * A machine whose `$TMPDIR` is long — a CI runner with a workspace in it, a dev box with a custom
 * temp root, a test harness under a run directory — put Chrome's socket past what a unix socket
 * path can hold, and EVERY e2e suite on that machine died at the launch for a reason that had
 * nothing to do with the code under test. The asked-for root is used whenever it fits, so a
 * machine with a roomy temp root keeps exactly the path it had.
 *
 * BOTH the profile and the browser's own `$TMPDIR` are under this root, because Chrome puts its
 * socket in `$TMPDIR` AND links it from the profile: a profile whose own path is too long is as
 * fatal as a temp root that is.
 *
 * POSIX only: the limit is a unix socket's, and Windows has none. There the root asked for is the
 * one used, exactly as before.
 */
export function browserTempRoot(
  root: string = tmpdir(),
  platform: string = process.platform,
): string {
  if (platform === 'win32') return root;
  if (root.length + 1 + SOCKET_PATH_RESERVE <= SOCKET_PATH_LIMIT) return root;
  // `/tmp` is the one root every POSIX machine has. If it is not there, the asked-for root is
  // used anyway: a launch that dies with a clear error beats one that dies with a missing
  // directory, and the long path it avoids is the lesser of the two faults.
  return existsSync('/tmp') ? '/tmp' : root;
}

/** A fresh profile directory under the temp root, named so a leak is recognisable as ours. */
export function throwawayProfile(root: string = browserTempRoot()): ThrowawayProfile {
  const path = mkdtempSync(join(root, 'x-e2e-chrome-'));
  return {
    path,
    singletonDir() {
      try {
        const target = readlinkSync(join(path, 'SingletonSocket'));
        return basename(target) === 'SingletonSocket' ? dirname(target) : undefined;
      } catch {
        return undefined;
      }
    },
    async remove(singleton, deadlineMs, settleMs = PROFILE_SETTLE_MS) {
      const until = performance.now() + deadlineMs;
      const owned = singleton !== undefined && isSingletonDir(singleton) ? singleton : undefined;
      const present = (): boolean => existsSync(path) || (owned !== undefined && existsSync(owned));
      do {
        quietly(() => rmSync(path, { recursive: true, force: true }));
        if (owned !== undefined) removeSingleton(owned);
        if (present()) {
          await Bun.sleep(settleMs / 5);
          continue;
        }
        // Gone NOW is not gone: the look after the settle is what a late writer fails.
        await Bun.sleep(settleMs);
        if (!present()) return;
      } while (performance.now() < until);
    },
  };
}
