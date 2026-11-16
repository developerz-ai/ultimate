// The bare `x` an adopter runs, as a child of an `error-catalog-process*` test: no test preload,
// so no render loader unless the catalog installs one. Shared so each child is a file of its own
// and test workers load the whole catalog twice side by side, not one after the other.

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
export const TEST_TIMEOUT_MS = 120_000;

/** `x <args>` as the bare CLI, no preload: exit code, stdout and stderr. */
export const run = async (
  ...args: string[]
): Promise<{ exit: number; out: string; err: string }> => {
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
