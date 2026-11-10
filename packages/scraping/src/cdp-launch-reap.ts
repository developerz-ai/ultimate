// One responsibility: nothing of a launched browser outlives its close — on POSIX its process GROUP,
// on Windows its process TREE — and the close waits until that is so, bounded.

/** How long a closed Chrome gets to exit on SIGTERM before it is killed outright. */
export const CLOSE_GRACE_MS = 5_000;

const GROUP_POLL_MS = 10;

/** Runs a command to its exit; the seam the Windows branch is asserted through on any runner. */
export type RunCommand = (argv: readonly string[]) => Promise<number>;

const runQuiet: RunCommand = (argv) =>
  // Bounded: taskkill ends a tree in well under a second; a stuck one must not stall `close()`.
  Bun.spawn([...argv], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000 }).exited;

/**
 * `/T` takes every process the browser started — renderer, GPU, network, crashpad — and `/F` does
 * not ask: a tree kill is the last step of a close, after the graceful one had its chance.
 */
export const taskkillArgv = (pid: number): readonly string[] => [
  'taskkill',
  '/T',
  '/F',
  '/PID',
  String(pid),
];

const within = (ms: number, work: Promise<unknown>): Promise<unknown> =>
  Promise.race([work, Bun.sleep(ms)]);

/**
 * Kill whatever is left of the browser's process group and wait until the group is EMPTY — the
 * condition, asked of the kernel, not a pause: signal 0 to a group with no member throws. Bounded
 * by `CLOSE_GRACE_MS` for a container whose init never reaps a zombie — on the monotonic clock,
 * not a count of sleeps: a loaded runner oversleeps every 10 ms, and the close's designed bound
 * (`LAUNCHED_CLOSE_MS`) is what a hook deadline is derived from.
 */
async function reapGroup(pgid: number): Promise<void> {
  const until = performance.now() + CLOSE_GRACE_MS;
  try {
    process.kill(-pgid, 'SIGKILL');
    while (performance.now() < until) {
      await Bun.sleep(GROUP_POLL_MS);
      process.kill(-pgid, 0);
    }
  } catch {
    // ESRCH: nothing is left in the group, which is the answer being waited for.
  }
}

/**
 * Everything the browser `pid` started, gone. On Windows `process.kill(-pgid)` is no call at all —
 * there is no process group, and the browser's children hold the profile's files open — so the
 * tree is walked by `taskkill`, which must run while the browser is still ALIVE: its children are
 * found by parent pid, and a dead parent's children are nobody's.
 */
export async function killTree(
  pid: number,
  platform: string = process.platform,
  run: RunCommand = runQuiet,
): Promise<void> {
  if (platform !== 'win32') return reapGroup(pid);
  try {
    await within(CLOSE_GRACE_MS, run(taskkillArgv(pid)));
  } catch {
    // No taskkill, or a tree already gone (exit 128): litter at worst, never the close's verdict.
  }
}
