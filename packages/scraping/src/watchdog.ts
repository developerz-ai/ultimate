// The wedge and zombie discipline, which is the difference between a scrape that fails and a
// scrape that pins a worker.
//
// Two real incidents, both from the same missing mechanism. One run held a queue slot for 3h11m
// and persisted nothing: the browser's socket was open, so every `await` was legitimately waiting
// and no timeout was armed on anything. Another left a browser process alive after its run ended
// and the queue could not be drained until a redeploy.
//
// So: an INACTIVITY watchdog that kills the OS process — killing it is what makes the blocked
// socket die, which is what turns an infinite await into a catchable `X_SCRAPE_WEDGED` — and a
// graceful-quit CEILING on shutdown, past which the same kill runs.

import type { ScrapeClock } from './clock';
import { watchdogStopped, wedged } from './error-throws';

export const DEFAULT_IDLE_MS = 120_000;
export const DEFAULT_GRACE_MS = 5_000;
const WATCH_POLL_MS = 250;

export interface WedgeGuardInit {
  readonly clock: ScrapeClock;
  /** Longest gap between two browser operations before the process is killed. */
  readonly idleMs?: number | undefined;
  /** How long a graceful quit may take before the same kill runs. */
  readonly graceMs?: number | undefined;
  /** What is being watched, for the cause line. */
  readonly what: string;
  /** The polite ending: `browser.close()`. May hang, which is the whole reason for the ceiling. */
  quit(): Promise<void>;
  /**
   * SIGKILL, not SIGTERM. A wedged Chrome ignores the polite signal — that is what "wedged"
   * means — and a kill that can be ignored is not a ceiling.
   */
  kill(): void;
}

export interface WedgeGuard {
  /** Aborts with `X_SCRAPE_WEDGED` when the idle budget passes. Handed to every wait. */
  readonly signal: AbortSignal;
  /** Called after every browser operation. The watchdog measures the gap between these. */
  touch(): void;
  /** Graceful quit under the ceiling, then kill. Idempotent, and never throws. */
  shutdown(): Promise<void>;
  /**
   * True once the watchdog ended the run — the idle budget passed, or the guard's own loop died
   * and stopped measuring. Either way a run that ends after this ended because of the watchdog.
   */
  readonly fired: boolean;
}

export function createWedgeGuard(init: WedgeGuardInit): WedgeGuard {
  const idleMs = init.idleMs ?? DEFAULT_IDLE_MS;
  const graceMs = init.graceMs ?? DEFAULT_GRACE_MS;
  const controller = new AbortController();
  let lastTouch = init.clock.monotonic();
  // TWO latches, not one. `stopped` ends the watch loop; `shuttingDown` guards the teardown. They
  // were the same flag, so a fire — which sets `stopped` — made `shutdown()` return on its first
  // line and NEVER call `quit()`. `localBrowser()` hid it, because the fire's `kill()` still
  // reaches a pid; `remoteBrowser()` is `driver-cdp.ts`'s primary path, `browser.process()` is
  // `null` there, and `browser.close()` is then the only thing that ends the paid remote session.
  let stopped = false;
  let shuttingDown = false;
  let fired = false;

  const watch = async (): Promise<void> => {
    while (!stopped) {
      await init.clock.sleep(WATCH_POLL_MS);
      if (stopped) return;
      if (init.clock.monotonic() - lastTouch < idleMs) continue;
      fired = true;
      stopped = true;
      // Kill FIRST, abort second. The abort is what the awaiting code sees; the kill is what
      // makes the socket it is blocked on close. Reversing them leaves the run cancelled and the
      // browser alive, which is the zombie half of the same incident.
      init.kill();
      controller.abort(wedged(init.what, idleMs));
    }
  };
  // Never floating. `ScrapeClock` is a seam an app implements and `init.kill()` comes from a
  // driver, so this loop can reject on somebody else's code — and a bare `void` turned that into
  // an unhandled rejection, a process-level event belonging to no run, with the guard silently
  // dead behind it. A guard that stopped measuring is incident #1 with nothing armed, so the run
  // is ended with an instruction instead of left unwatched.
  void watch().catch((thrown: unknown) => {
    if (stopped) return;
    stopped = true;
    fired = true;
    controller.abort(watchdogStopped(init.what, thrown));
  });

  return {
    signal: controller.signal,
    get fired(): boolean {
      return fired;
    },
    touch(): void {
      lastTouch = init.clock.monotonic();
    },
    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      stopped = true;
      let quit = false;
      // A ceiling, not a hope: whichever finishes first wins, and if it is the clock the process
      // is killed. `browser.close()` on a wedged renderer never returns.
      await Promise.race([
        init.quit().then(
          () => {
            quit = true;
          },
          () => {
            quit = false;
          },
        ),
        // The ceiling's own sleep is caught for the same reason the quit is: this runs in
        // `runScrape`'s `finally`, `close()` is documented never to throw, and a clock that
        // rejected here would replace the run's real failure with a teardown one. A ceiling that
        // cannot be timed has already expired, which lands on `kill()` — the safe direction.
        init.clock.sleep(graceMs).catch(() => undefined),
      ]);
      if (!quit) init.kill();
    },
  };
}
