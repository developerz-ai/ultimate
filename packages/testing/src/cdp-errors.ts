// One constructor per way the raw-CDP e2e browser refuses. Every cause quotes a value that came
// out of a BROWSER or off a spawned process's stderr, so every one is rendered rather than
// interpolated — the rule `e2e-errors.ts` already states.

import { isFixShellSafe, renderCauseValue, UltimateError } from '@ultimat3/core';
// Bare: the titles these constructors' codes render with are registered there.
import './e2e-error-codes';

/**
 * No browser to drive. This is the one an author meets first, so its fix names the two ways out:
 * point the driver at a binary, or accept that this machine cannot run the check.
 */
export class CdpBrowserMissingError extends UltimateError {
  constructor(input: { readonly tried: readonly string[] }) {
    super({
      code: 'X_CDP_BROWSER_MISSING',
      cause: `no Chrome or Chromium executable was found — tried ${renderCauseValue(input.tried)}`,
      fix: 'set CHROME_PATH to a Chrome or Chromium binary (GitHub-hosted ubuntu runners ship one at /usr/bin/google-chrome), or skip the browser-backed e2e suite by leaving it unset',
    });
  }
}

/** One start of the browser that ended without an answer — what `cdp-launch-attempt.ts` reports. */
export interface CdpLaunchAttempt {
  /** `deadline`: alive and silent for `waitedMs`. `closed`: its pipe ended before any answer. */
  readonly why: 'deadline' | 'closed';
  readonly waitedMs: number;
  /** The code it exited with on its own, or `null` when the launcher had to kill it. */
  readonly exitCode: number | null;
  /** The last lines it wrote to stderr; empty when it wrote none. */
  readonly stderr: string;
}

const HAND_FLAGS =
  '--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-port=0 about:blank';

const attemptText = (attempt: CdpLaunchAttempt, index: number): string => {
  const ended =
    attempt.why === 'deadline'
      ? `no answer inside ${String(attempt.waitedMs)}ms, so it was killed`
      : attempt.exitCode === null
        ? `closed its DevTools pipe after ${String(attempt.waitedMs)}ms without answering, and was killed`
        : `exited with code ${String(attempt.exitCode)} after ${String(attempt.waitedMs)}ms without answering`;
  const said = attempt.stderr === '' ? 'it printed nothing' : renderCauseValue(attempt.stderr);
  return `launch ${String(index + 1)}: ${ended}; stderr: ${said}`;
};

/**
 * The binary ran and never answered a DevTools call — a crash, a bad flag, a sandbox refusal, or a
 * machine too loaded to start it inside the launch deadline. Every attempt is in the cause with its
 * own stderr, because Chrome's start-up noise reads the same in a healthy browser and a dead one:
 * what tells them apart is whether it EXITED or was still starting when the deadline passed.
 */
export class CdpLaunchFailedError extends UltimateError {
  constructor(input: {
    readonly executable: string;
    readonly attempts: readonly CdpLaunchAttempt[];
  }) {
    // Run by hand, a healthy Chrome prints `DevTools listening on ws://…` and a broken one prints
    // why. A path that is not shell-inert is the operator's own CHROME_PATH — every candidate is.
    const binary = isFixShellSafe(input.executable) ? input.executable : '"$CHROME_PATH"';
    super({
      code: 'X_CDP_LAUNCH_FAILED',
      cause: `${renderCauseValue(input.executable)} did not announce a DevTools endpoint: it answered no DevTools call in ${String(input.attempts.length)} ${input.attempts.length === 1 ? 'launch' : 'launches, each on its own fresh profile'} — ${input.attempts.map(attemptText).join(' · ')}`,
      fix: `${binary} ${HAND_FLAGS}`,
      meta: { executable: input.executable, attempts: input.attempts },
    });
  }
}

/** A CDP call answered with an error frame, or the connection died under it. */
export class CdpCallFailedError extends UltimateError {
  constructor(input: { readonly method: string; readonly detail: string }) {
    super({
      code: 'X_CDP_CALL_FAILED',
      cause: `the browser refused ${renderCauseValue(input.method)}: ${renderCauseValue(input.detail)}`,
      fix: 'print what the page had: await page.evaluate(() => document.body.innerHTML) — a call that refuses the same way means the browser itself is gone, so read the launch above it',
    });
  }
}

/** How a call's target went away: its session detached, its target was destroyed, or it crashed. */
export type CdpTargetGone = 'detached' | 'destroyed' | 'crashed';

/** What the wire did between a call being sent and its deadline (`cdp-wire-watch.ts`). */
export interface CdpTimeoutObservation {
  /** The session the call was sent on; `null` for a browser-level call. */
  readonly sessionId: string | null;
  /** Frames that arrived and parsed after the call was sent — replies to other calls, and events. */
  readonly framesArrived: number;
  /** The last of those, oldest first, bounded: `reply <id>`, or `<method> @<session>`. */
  readonly lastFrames: readonly string[];
  /** Frames that arrived after the call and could not be parsed. One of them may be its reply. */
  readonly framesDropped: number;
  readonly transportOpen: boolean;
  /** `detached`, `destroyed` or `crashed` when the call's target went away; `null` while it is there. */
  readonly targetGone: CdpTargetGone | null;
  /** Main-frame navigations on the call's session since it was sent. */
  readonly navigations: number;
}

/** The one-word verdict a reader — or a script over `--json` — branches on. */
export type CdpTimeoutReading = 'target-gone' | 'lost-in-transport' | 'no-answer';

export const readTimeout = (seen: CdpTimeoutObservation): CdpTimeoutReading =>
  seen.targetGone !== null
    ? 'target-gone'
    : seen.framesDropped > 0
      ? 'lost-in-transport'
      : 'no-answer';

const READING: Record<CdpTimeoutReading, (seen: CdpTimeoutObservation) => string> = {
  'target-gone': (seen) =>
    `its target is gone (${String(seen.targetGone)}), so nothing was left to answer`,
  'lost-in-transport': (seen) =>
    `${String(seen.framesDropped)} frame(s) arrived unparseable after it was sent and were dropped, so its reply may have been lost in transport (${String(seen.framesArrived)} other frame(s) arrived intact)`,
  'no-answer': (seen) => {
    if (seen.framesArrived === 0) {
      return `nothing at all arrived after the call was sent, on a transport that is ${seen.transportOpen ? 'still open' : 'closed'} — the whole browser went silent`;
    }
    const moved =
      seen.navigations === 0
        ? ''
        : `; the page navigated ${String(seen.navigations)} time(s) since the call`;
    return `the target did not answer: ${String(seen.framesArrived)} other frame(s) arrived intact after the call, the last ${renderCauseValue(seen.lastFrames)}${moved}`;
  },
};

/**
 * A call that never answered. Its own code rather than `X_TIMEOUT`, because the actionable half is
 * WHICH call: a hung `Page.navigate` is an app that never finishes responding, and a hung
 * `Runtime.evaluate` is an expression that never settles.
 *
 * `observed` is what the connection saw meanwhile, and it is what tells three failures apart that
 * all read "did not answer": the target went away, the reply was dropped on the wire, or the target
 * was there and silent. A deadline the connection did not keep (`waitFor`, the handshake) has none.
 */
export class CdpTimeoutError extends UltimateError {
  constructor(input: {
    readonly method: string;
    readonly timeoutMs: number;
    readonly observed?: CdpTimeoutObservation | undefined;
  }) {
    const { observed } = input;
    const base = `${renderCauseValue(input.method)} did not answer inside ${String(input.timeoutMs)}ms`;
    const reading = observed === undefined ? undefined : readTimeout(observed);
    super({
      code: 'X_CDP_TIMEOUT',
      cause:
        observed === undefined || reading === undefined
          ? base
          : `${base} — ${READING[reading](observed)}`,
      fix:
        reading === undefined || reading === 'no-answer'
          ? 'raise timeoutMs on installE2eDriver({ timeoutMs }), or find the request the page is still waiting on — a navigation that never settles is an app that never finishes its response'
          : // `--json`: the rerun's `meta.reading` and `meta.framesDropped` are only printed there.
            'x test e2e --json',
      ...(observed === undefined
        ? {}
        : { meta: { method: input.method, timeoutMs: input.timeoutMs, reading, ...observed } }),
    });
  }
}
