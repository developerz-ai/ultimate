// One responsibility: compose the halves — find a browser, launch it over its pipe, attach a page —
// into the one object `installE2eDriver({ page })` takes, plus the way to shut it down.
//
// **Absent is a SKIP, never a failure, and that is a requirement rather than a state.** A CI box
// with no Chrome must not turn the `e2e` step red for a reason unrelated to the change, which is
// the rule `packages/cli/CLAUDE.md` already states about `x shot`, `x pr` and `x ci`.
// `openE2eBrowserIfAvailable` is that door; `openE2eBrowser` refuses by name for a caller that has
// already decided a browser is required.

import { finiteCount } from '@ultimat3/core';
import type { E2eTab } from './cdp-e2e-page';
import type { E2eSession } from './cdp-e2e-session';
import { cdpE2eSession } from './cdp-e2e-session';
import { CdpBrowserMissingError } from './cdp-errors';
import type { LaunchedBrowser } from './cdp-launch';
import { CHROME_CANDIDATES, findChrome, launchChrome } from './cdp-launch';

/** How long a launch, a connect or a single CDP call may take. One number, three deadlines. */
export const DEFAULT_CDP_TIMEOUT_MS = 30_000;

export interface E2eBrowser {
  /** The first tab — what `installE2eDriver({ page })` drives. */
  readonly page: E2eTab;
  /**
   * The browser itself: more tabs in the same profile, init scripts, the offline switch for every
   * page and worker, and the log of every socket and request. What a multi-tab acceptance suite
   * drives, on the same launch as `page` — one harness, never a second one beside the driver.
   */
  readonly session: E2eSession;
  /** Idempotent, and it closes both halves: the CDP socket, then the process and its profile. */
  close(): void;
}

export interface OpenE2eBrowserOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly timeoutMs?: number | undefined;
  /** Pinned as `Accept-Language` on every request (`cdp-e2e-session.ts`). Absent: Chrome's own. */
  readonly acceptLanguage?: string | undefined;
}

/**
 * Screened HERE, before a browser exists, and not where it lands. It becomes three deadlines — the
 * launch, the handshake and every CDP call — and `Number(process.env.E2E_TIMEOUT ?? '')` is `NaN`
 * for an unset variable and is not nullish, so `??` keeps it: a `setTimeout` given `NaN` fires at
 * 1ms in this Bun, which makes every call report `X_CDP_TIMEOUT` against a browser that was
 * answering. A misdiagnosis reported as a test failure is worse than the failure.
 */
const budget = (options: OpenE2eBrowserOptions): number =>
  finiteCount('openE2eBrowser', 'timeoutMs', options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS);

const compose = (launched: LaunchedBrowser, session: E2eSession, page: E2eTab): E2eBrowser => ({
  page,
  session,
  // The connection first, then the process — `launched.close()` does both, in that order: closing
  // the process out from under an open connection makes every in-flight call report "the browser
  // closed the CDP connection", which is true and useless.
  close: () => launched.close(),
});

/**
 * Launch a browser and attach one page to it. Refuses with `X_CDP_BROWSER_MISSING` when there is
 * nothing to launch — the caller that wants a skip asks `openE2eBrowserIfAvailable` instead.
 */
export async function openE2eBrowser(options: OpenE2eBrowserOptions = {}): Promise<E2eBrowser> {
  const timeoutMs = budget(options);
  const executable = await findChrome(options.env ?? process.env);
  if (executable === undefined) throw new CdpBrowserMissingError({ tried: CHROME_CANDIDATES });
  return openLaunched(executable, timeoutMs, options.acceptLanguage);
}

/** `undefined` when this machine has no browser. Every other failure still throws. */
export async function openE2eBrowserIfAvailable(
  options: OpenE2eBrowserOptions = {},
): Promise<E2eBrowser | undefined> {
  const timeoutMs = budget(options);
  const executable = await findChrome(options.env ?? process.env);
  if (executable === undefined) return undefined;
  return openLaunched(executable, timeoutMs, options.acceptLanguage);
}

/**
 * The half both doors share. Each step undoes the ones before it on the way out: a Chrome that
 * launched and then refused the CDP handshake would otherwise be left running, holding its profile
 * directory, for the rest of the test process — one leaked browser per failing suite.
 */
async function openLaunched(
  executable: string,
  timeoutMs: number,
  acceptLanguage: string | undefined,
): Promise<E2eBrowser> {
  const launched = await launchChrome({ executable, timeoutMs });
  const { connection } = launched;
  try {
    const session = await cdpE2eSession({
      connection,
      loadTimeoutMs: timeoutMs,
      ...(acceptLanguage === undefined ? {} : { acceptLanguage }),
    });
    return compose(launched, session, await session.newTab());
  } catch (error) {
    launched.close();
    throw error;
  }
}
