// One responsibility: whether a candidate Chrome is one this machine can START — `--version`, under
// a deadline of its own. Which candidates are tried, and in what order, is `cdp-launch.ts`.

/**
 * The longest a candidate gets to answer `--version`. A warm Chrome answers in ~40 ms; a cold binary
 * on a loaded runner is the slow case, and one that has not answered by then is not a browser this
 * run can drive. Its own number, never the launch deadline: this is spent BEFORE one.
 */
export const CHROME_PROBE_TIMEOUT_MS = 15_000;

/**
 * A browser banner: a product this launcher can drive, then a dotted version.
 *
 * Read only when the candidate PRINTED something. `--version` is not a browser's alone — `bun
 * --version` exits 0 and prints `1.4.4` — so output that names no browser is output from something
 * that is not one. Silence is the other case, and it is accepted: a browser that starts and stops
 * cleanly saying nothing judges nothing it was not told.
 */
const BROWSER_BANNER = /(?:chrome|chromium|edge)[^\n]*?\d+\.\d+/i;

/**
 * Whether `candidate` is a browser this machine can actually START — not merely a file that exists.
 *
 * The two are not the same, and the difference is a whole red gate: Ubuntu 24.04 ships
 * `/usr/bin/chromium-browser` as a shell wrapper around `snap`, which is present and executable on
 * every install and which exits 1 having started nothing where no snap cgroup exists (`is not a snap
 * cgroup for tag snap.chromium.chromium`, measured 2026-11). A candidate that cannot start is an
 * ABSENT candidate: the browser-backed suites' headers promise a SKIP, not `X_CDP_LAUNCH_FAILED`.
 *
 * NOT RUN on `win32`, where existence is the answer: `chrome.exe` is a GUI binary, and `--version`
 * there opens a browser and never exits — #1033's Windows job spent 15 s on each of two candidates
 * and timed out the test that asked. The snap wrapper this probe exists for is Linux-only.
 *
 * TOTAL: a candidate that cannot be spawned, dies, misses the deadline, or PRINTS something that
 * names no browser is `false`, never a throw. One deadline covers the exit AND the banner: a
 * grandchild that inherits stdout holds the pipe open past the child's own exit.
 */
export async function startsChrome(
  candidate: string,
  platform: string,
  timeoutMs: number = CHROME_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (platform === 'win32') return true;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // `timeout:` is Bun's own kill at the deadline, so a probe this function stopped waiting on
    // is never left running.
    child = Bun.spawn([candidate, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
    });
  } catch {
    return false;
  }
  const banner = new Response(child.stdout as ReadableStream<Uint8Array>).text().catch(() => '');
  const answered = child.exited.then(async (code) =>
    code === 0 ? (await banner).trim() : undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    // real-clock: bounds a spawned process, not a timer a test arms.
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const printed = await Promise.race([answered, deadline]);
    if (printed === undefined) return false;
    return printed === '' || BROWSER_BANNER.test(printed);
  } finally {
    clearTimeout(timer);
    // A probe that timed out is still a live process; one that exited ignores this.
    child.kill();
  }
}
