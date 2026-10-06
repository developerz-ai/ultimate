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
import { CHROME_CANDIDATES, findChrome, LAUNCH_BUDGET_MS, launchChrome } from './cdp-launch';
import { LAUNCHED_CLOSE_MS } from './cdp-launch-attempt';

/** How long a launch, a connect or a single CDP call may take. One number, three deadlines. */
export const DEFAULT_CDP_TIMEOUT_MS = 30_000;

/**
 * Sequential deadlines `cdpE2eSession` spends before it answers — `Target.setDiscoverTargets`,
 * then `Target.setAutoAttach` — and `newTab()` spends per tab: `Target.createTarget`, then the
 * attach that publishes it. Counts of calls in `cdp-e2e-session.ts`, held to it by
 * `cdp-browser.test.ts` over a fake connection.
 */
export const SESSION_SETUP_DEADLINES = 2;
export const TAB_OPEN_DEADLINES = 2;

/** The longest one more `session.newTab()` is designed to take, at the default per-call deadline. */
export const E2E_TAB_OPEN_MS = TAB_OPEN_DEADLINES * DEFAULT_CDP_TIMEOUT_MS;

/**
 * The longest `openE2eBrowser()` is DESIGNED to take, at the default deadline: the whole launch
 * budget — both starts and their reaps — then the session's setup and the first tab. THE deadline
 * for a `beforeAll` or `afterAll` that opens or closes a browser: one below it is killed by Bun
 * before the relaunch, and the failure that names the slow step never surfaces. Derived, never
 * restated: `e2e-browser-hooks.test.ts` refuses a browser hook whose deadline does not start here.
 */
export const E2E_BROWSER_OPEN_MS =
  LAUNCH_BUDGET_MS + SESSION_SETUP_DEADLINES * DEFAULT_CDP_TIMEOUT_MS + E2E_TAB_OPEN_MS;

/**
 * The longest `E2eBrowser.close()` is DESIGNED to take — the launched browser's close, every step
 * bounded (`LAUNCHED_CLOSE_MS`). THE deadline for a hook that closes a browser it already holds: a
 * hook left at Bun's 5 s default is killed mid-close, and when it is the run's last the process
 * exits with the profile half-removed — the `x-e2e-chrome-*` directories found leaked in `/tmp`.
 */
export const E2E_BROWSER_CLOSE_MS = LAUNCHED_CLOSE_MS;

/**
 * Sequential deadlines one `tab.goto()` spends: the load event raced against `Page.navigate`'s
 * reply (one deadline, two waiters), then the two reads of the document (`cdp-e2e-page.ts`). Held
 * to the method by `cdp-browser.test.ts` over a fake connection, as the tab's count is.
 */
export const GOTO_DEADLINES = 3;

/** The longest one `tab.goto()` is designed to take, at the default per-call deadline. */
export const E2E_GOTO_MS = GOTO_DEADLINES * DEFAULT_CDP_TIMEOUT_MS;

export interface E2eBrowser {
  /** The first tab — what `installE2eDriver({ page })` drives. */
  readonly page: E2eTab;
  /**
   * The browser itself: more tabs in the same profile, init scripts, the offline switch for every
   * page and worker, and the log of every socket and request. What a multi-tab acceptance suite
   * drives, on the same launch as `page` — one harness, never a second one beside the driver.
   */
  readonly session: E2eSession;
  /**
   * THE close, idempotent, awaited: the CDP connection, then the process, its process group and its
   * profile (bounded — `CLOSE_GRACE_MS` per step). Unawaited, a process that exits next leaves a
   * Chrome child and a profile directory behind.
   */
  close(): Promise<void>;
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
    await launched.close();
    throw error;
  }
}
