// One constructor per way the raw-CDP e2e browser refuses. Every cause quotes a value that came
// out of a BROWSER or off a spawned process's stderr, so every one is rendered rather than
// interpolated — the rule `e2e-errors.ts` already states.

import { renderCauseValue, UltimateError } from '@ultimat3/core';

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

/** The binary ran and never announced an endpoint — a crash, a bad flag, or a sandbox refusal. */
export class CdpLaunchFailedError extends UltimateError {
  constructor(input: { readonly executable: string; readonly detail: string }) {
    super({
      code: 'X_CDP_LAUNCH_FAILED',
      cause: `${renderCauseValue(input.executable)} did not announce a DevTools endpoint: ${renderCauseValue(input.detail)}`,
      fix: 'run the same binary by hand with --headless=new --remote-debugging-port=0 and read its stderr; inside a container add --no-sandbox --disable-dev-shm-usage, which this launcher already passes',
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
