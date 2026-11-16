// One responsibility: the launch FIXTURE — ready once the endpoint answered AND the page it was
// handed exists, heard as an event, never polled for — and the one deadline a test awaiting a
// launch takes, derived from the launch's budget (`scripts/launch-deadline.ts` refuses any other).

import type { CdpConnection } from './cdp-connection';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';
import type { LaunchedBrowser, LaunchOptions } from './cdp-launch';
import { LAUNCH_ATTEMPTS, LAUNCH_TIMEOUT_MS, launchChrome } from './cdp-launch';
import { CLOSE_GRACE_MS, LAUNCH_REAP_MS, LAUNCHED_CLOSE_MS } from './cdp-launch-attempt';

/**
 * How early a timer may fire against `performance.now()`: a fractional delay is floored. A `false`
 * from `once` with less than this left is the deadline, not a closed connection.
 */
const TIMER_GRAIN_MS = 1;

/**
 * The longest a test that awaits ONE `launchReady` at `launchTimeoutMs` is designed to take, on its
 * worst path — a browser that started and went silent: every start its deadline and its reap, the
 * handshake its whole deadline (the off-switch spends only what is left of it), then the close
 * `launchReady` makes — plus one `CLOSE_GRACE_MS` of slack for timers on a loaded runner. A test
 * given less is killed by Bun first, and the refusal naming the slow step never surfaces — a cold
 * Chrome on a loaded Windows runner read as a test timeout (`be5b7edb8`).
 */
export const launchTestMs = (launchTimeoutMs: number): number =>
  LAUNCH_ATTEMPTS * (launchTimeoutMs + LAUNCH_REAP_MS) +
  launchTimeoutMs +
  LAUNCHED_CLOSE_MS +
  CLOSE_GRACE_MS;

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
      const heard = await connection.once('Target.targetCreated', undefined, left);
      // `false` with time left is a CLOSED connection — `once` answers it at once, and looping on
      // it spun the event loop to the deadline and called a dead browser a slow one.
      if (!heard && !ready && until - performance.now() > TIMER_GRAIN_MS) {
        throw new CdpCallFailedError({
          method: 'the connection',
          detail: 'the CDP connection closed while waiting for the page target',
        });
      }
    }
    if (!ready)
      throw new CdpTimeoutError({ method: 'Target.targetCreated', timeoutMs: deadlineMs });
  } finally {
    off();
    // Inside what is LEFT of the deadline, never a fresh one: a silent browser cost two deadlines
    // and the close past `launchTestMs`. Best-effort — at the deadline it is sent and not awaited.
    await connection
      .send(
        'Target.setDiscoverTargets',
        { discover: false },
        undefined,
        Math.max(TIMER_GRAIN_MS, until - performance.now()),
      )
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
