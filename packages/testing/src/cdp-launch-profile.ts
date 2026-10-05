// One responsibility: the throwaway profile a launch hands Chrome, and its removal — after every
// process of the browser is gone, retried while something re-creates it, bounded — together with
// the singleton-socket directory Chrome makes BESIDE it in the temp root.

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
   * and answer once neither has come back for `PROFILE_SETTLE_MS`, or at `deadlineMs`. Never throws:
   * a directory that will not go is litter, never the close's verdict.
   */
  remove(singleton: string | undefined, deadlineMs: number): Promise<void>;
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

/** A fresh profile directory under the temp root, named so a leak is recognisable as ours. */
export function throwawayProfile(root: string = tmpdir()): ThrowawayProfile {
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
    async remove(singleton, deadlineMs) {
      const until = performance.now() + deadlineMs;
      const owned = singleton !== undefined && isSingletonDir(singleton) ? singleton : undefined;
      const present = (): boolean => existsSync(path) || (owned !== undefined && existsSync(owned));
      do {
        quietly(() => rmSync(path, { recursive: true, force: true }));
        if (owned !== undefined) removeSingleton(owned);
        if (present()) {
          await Bun.sleep(PROFILE_SETTLE_MS / 5);
          continue;
        }
        // Gone NOW is not gone: the look after the settle is what a late writer fails.
        await Bun.sleep(PROFILE_SETTLE_MS);
        if (!present()) return;
      } while (performance.now() < until);
    },
  };
}
