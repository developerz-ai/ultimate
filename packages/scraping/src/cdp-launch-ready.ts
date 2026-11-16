// One responsibility: the launch FIXTURE — ready once the endpoint answered AND the page it was
// handed exists, heard as an event, never polled for — and the one deadline a test awaiting a
// launch takes, derived from the launch's budget (`scripts/launch-deadline.ts` refuses any other).

import type { CdpConnection } from './cdp-connection';
import { CdpTimeoutError } from './cdp-errors';
import type { LaunchedBrowser, LaunchOptions } from './cdp-launch';
import { LAUNCH_ATTEMPTS, LAUNCH_TIMEOUT_MS, launchChrome } from './cdp-launch';
import { LAUNCH_REAP_MS } from './cdp-launch-attempt';

/** Handshake deadlines after the launch: discovery switched on, then its announcement of a page. */
const READY_DEADLINES = 2;

/**
 * The longest a test that awaits ONE launch at `launchTimeoutMs` is designed to take: every start
 * its deadline and its reap, then the handshake. A test given less is killed by Bun first, and the
 * `X_CDP_LAUNCH_FAILED` naming the slow step never surfaces — a cold Chrome on a loaded Windows
 * runner read as a test timeout (`be5b7edb8`).
 */
export const launchTestMs = (launchTimeoutMs: number): number =>
  LAUNCH_ATTEMPTS * (launchTimeoutMs + LAUNCH_REAP_MS) + READY_DEADLINES * launchTimeoutMs;

/** `launchTestMs` at the default launch deadline: the test deadline for `launchReady`. */
export const LAUNCH_TEST_MS = launchTestMs(LAUNCH_TIMEOUT_MS);

const isPage = (params: Record<string, unknown>): boolean => {
  const info = params['targetInfo'];
  return typeof info === 'object' && info !== null && (info as { type?: unknown }).type === 'page';
};

/**
 * Resolve once the browser has a `page` target. Discovery announces every target that already
 * exists and every one created later, so a page that starts after the endpoint answered — a cold
 * start on Windows — is waited for, and one already there is heard at once. Discovery is switched
 * back off on every exit: the session a caller builds next asks for its own. `X_CDP_TIMEOUT` past
 * `deadlineMs`.
 */
export async function pageTargetReady(
  connection: CdpConnection,
  deadlineMs: number,
): Promise<void> {
  const until = performance.now() + deadlineMs;
  let ready = false;
  const off = connection.on('Target.targetCreated', (params) => {
    if (isPage(params)) ready = true;
  });
  try {
    await connection.send('Target.setDiscoverTargets', { discover: true }, undefined, deadlineMs);
    // The connection's own event wait is the bound: no timer of this file's (`clock-discipline`).
    for (
      let left = until - performance.now();
      !ready && left > 0;
      left = until - performance.now()
    ) {
      await connection.once('Target.targetCreated', undefined, left);
    }
    if (!ready)
      throw new CdpTimeoutError({ method: 'Target.targetCreated', timeoutMs: deadlineMs });
  } finally {
    off();
    await connection
      .send('Target.setDiscoverTargets', { discover: false }, undefined, deadlineMs)
      .catch(() => undefined);
  }
}

/**
 * THE launch fixture: `launchChrome`, then `pageTargetReady` inside the launch deadline. A browser
 * whose page never appears is closed before the refusal reaches the test. Await it inside a test
 * given `launchTestMs(launchTimeoutMs)` — `LAUNCH_TEST_MS` at the default.
 */
export async function launchReady(options: LaunchOptions): Promise<LaunchedBrowser> {
  const launched = await launchChrome(options);
  try {
    await pageTargetReady(
      launched.connection,
      options.launchTimeoutMs ?? Math.max(options.timeoutMs, LAUNCH_TIMEOUT_MS),
    );
  } catch (error) {
    await launched.close();
    throw error;
  }
  return launched;
}
