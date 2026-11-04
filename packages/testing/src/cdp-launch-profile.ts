// One responsibility: the throwaway profile a launch hands Chrome, and its removal — after every
// process of the browser is gone, retried while something re-creates it, bounded — together with
// the singleton-socket directory Chrome makes BESIDE it in the temp root.

// why: Bun exposes no temp-root, recursive-remove or readlink primitive; the profile needs all three.
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
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
   * The temp root the BROWSER must run under, and the one the profile lives in.
   *
   * Chrome's ProcessSingleton puts its socket in `$TMPDIR`, not in the profile: the path is
   * `$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket`, and a UNIX socket path is capped at 108
   * bytes by the kernel. A machine whose `TMPDIR` is 64 characters or longer therefore kills
   * Chrome at start-up with `FATAL: Socket path too long`, before it ever announces a DevTools
   * endpoint — and the launcher reported that as `X_CDP_LAUNCH_FAILED`, naming the browser
   * rather than the cause. So the browser is given a temp root short enough for that socket.
   */
  readonly tempRoot: string;
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
 * The longest a temp root may be and still leave room for Chrome's singleton socket.
 *
 * `$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket` is 45 characters past the root, and the
 * kernel caps a UNIX socket path at 108 bytes — measured on this box: a root of 60 characters
 * launches, 66 does not. 63 is the last root that fits.
 */
export const MAX_BROWSER_TEMP_ROOT = 63;

/**
 * A candidate temp root the browser can be given: short enough for Chrome's singleton socket, a
 * directory, and writable.
 *
 * Existence alone is not enough. A root that exists but cannot be written in is a profile the
 * browser cannot make and a socket it cannot create, and the launch dies inside Chrome with no
 * reason named — so writability is asked, not assumed.
 */
function isUsableTempRoot(candidate: string): boolean {
  if (candidate.length > MAX_BROWSER_TEMP_ROOT) return false;
  try {
    if (!statSync(candidate).isDirectory()) return false;
    accessSync(candidate, constants.W_OK);
    return true;
  } catch {
    // Missing, not a directory, or not writable: not a root the browser can be given.
    return false;
  }
}

/**
 * A temp root short enough for Chrome's singleton socket, whatever `TMPDIR` says.
 *
 * The OS temp root is used when it is short enough AND usable. When it is not, `/tmp` is tried
 * next (it is the root Linux and macOS both default to). The rule is LENGTH, not ownership: the
 * process's own `TMPDIR` IS the root when it is short enough, which is every ordinary machine.
 *
 * A candidate that is refused is NEVER handed back — the answer is `undefined` instead. A root
 * over the limit is exactly what kills Chrome at start-up with `FATAL: Socket path too long`, and
 * a root the browser cannot write in is a profile it cannot make: both are the launch's failure
 * to report with its reason, not a root to pass on and let Chrome die inside.
 *
 * `candidates` is a parameter so the rule can be asked about roots this process does not have.
 */
export function browserTempRoot(
  candidates: readonly string[] = [tmpdir(), '/tmp'],
): string | undefined {
  for (const candidate of candidates) {
    if (isUsableTempRoot(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A fresh profile directory under a temp root short enough for Chrome, named so a leak is
 * recognisable as ours.
 *
 * The profile and the singleton socket share ONE root: the socket's path is what the 108-byte
 * limit is about, so a profile under a different root would leave the socket where the limit is.
 *
 * The root is named by the caller, never defaulted: `browserTempRoot()` answers `undefined`
 * when no root is usable, and that refusal has to reach the launch as a failure — not
 * become a profile under a root Chrome cannot use.
 */
export function throwawayProfile(root: string): ThrowawayProfile {
  const path = mkdtempSync(join(root, 'x-e2e-chrome-'));
  return {
    path,
    tempRoot: root,
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
