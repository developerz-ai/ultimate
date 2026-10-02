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

/**
 * A call that never answered. Its own code rather than `X_TIMEOUT`, because the actionable half is
 * WHICH call: a hung `Page.navigate` is an app that never finishes responding, and a hung
 * `Runtime.evaluate` is an expression that never settles.
 */
export class CdpTimeoutError extends UltimateError {
  constructor(input: { readonly method: string; readonly timeoutMs: number }) {
    super({
      code: 'X_CDP_TIMEOUT',
      cause: `${renderCauseValue(input.method)} did not answer inside ${String(input.timeoutMs)}ms`,
      fix: 'raise timeoutMs on installE2eDriver({ timeoutMs }), or find the request the page is still waiting on — a navigation that never settles is an app that never finishes its response',
    });
  }
}
