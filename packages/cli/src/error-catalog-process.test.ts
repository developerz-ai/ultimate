// The catalog as an installed `x` process sees it: no test preload, so no render loader unless the
// catalog installs one. The in-process suite cannot tell — `scripts/test-setup.ts` installs it for
// every test file, which is exactly how `x errors` shipped unable to load `@ultimat3/admin`.

import { describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun exposes no path-join primitive.
import { join } from 'node:path';

const BIN = join(import.meta.dir, 'bin.ts');

// A cold `bun bin.ts` loads the whole catalog — every `@ultimat3/*` package — and that is time, not
// correctness. Measured quiet (no CI contention), the two bare-CLI children import every package
// in 6.7 s and 8.0 s. That quiet figure is not the budget this protects: the gate's six unit
// workers previously reached their 30 s deadline under CI contention alone, with the children
// nowhere near wedged — contention, not import time, is what these two numbers budget for. 110 s
// kills a contended or genuinely wedged child well ahead of the test's own 120 s deadline, leaving
// 10 s for `run()` to report the exit and for the test worker to clean up: a wedged child must
// not survive a timed-out test worker.
const PROCESS_TIMEOUT_MS = 110_000;
const TEST_TIMEOUT_MS = 120_000;

const run = async (...args: string[]): Promise<{ exit: number; out: string; err: string }> => {
  // `bun <file>` reads no `[test]` preload: the child is the bare CLI an adopter runs.
  const child = Bun.spawn(['bun', BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: PROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exit, out, err };
};

describe('process · x errors without the test preload', () => {
  test(
    'explains a code owned by a `.tsx` package (admin)',
    async () => {
      const { exit, out, err } = await run('errors', 'explain', 'X_ADMIN_INVALID', '--json');
      expect({ exit, ok: JSON.parse(out).ok, err }).toEqual({ exit: 0, ok: true, err: '' });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'lists every package with nothing failed to initialize',
    async () => {
      const { exit, out } = await run('errors', 'list', '--json');
      const doc: unknown = JSON.parse(out);
      expect({ exit, doc }).toMatchObject({ exit: 0, doc: { ok: true } });
      expect(JSON.stringify(doc)).not.toContain('failed to initialize');
    },
    TEST_TIMEOUT_MS,
  );
});
