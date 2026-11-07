// TEST-ONLY. Removes a test's temp directory when Windows has not yet let go of a file in it. A
// process that just exited can still have its executable image mapped, and a fresh `.exe` is
// scanned by the antivirus: either answers `rm` with EBUSY or EPERM for a moment after `exited`
// resolved. Bun's `rmSync` ignores Node's `maxRetries`, so the bounded wait is here.

// why: Bun ships no recursive delete; `rmSync` is what a temp directory's removal needs.
import { rmSync } from 'node:fs';
import { backoffDelay } from './backoff';
import { stringField } from './error-render';

/** ~3.5 s in all (50 ms doubling, 1 s ceiling); a holder that never lets go is still the error. */
export const REMOVE_ATTEMPTS = 8;

export interface RemoveIo {
  readonly remove: (path: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

const isHeldOpen = (code: string | undefined): boolean => code === 'EBUSY' || code === 'EPERM';

/** The real filesystem and the real wait: an OS holding a file lets go on ITS clock, not ours. */
const REAL_IO: RemoveIo = {
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  sleep: (ms) => Bun.sleep(ms),
};

/** `remove(path)`, retried on EBUSY/EPERM only, `REMOVE_ATTEMPTS` tries in all. */
export async function removeTempDir(path: string, io: RemoveIo = REAL_IO): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      io.remove(path);
      return;
    } catch (error) {
      if (attempt >= REMOVE_ATTEMPTS || !isHeldOpen(stringField(error, 'code'))) throw error;
      await io.sleep(backoffDelay({ attempt, base: 50, max: 1_000 }));
    }
  }
}
