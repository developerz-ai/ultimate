// `@ultimat3/scraping/cdp` — the raw-CDP browser as a runtime: find a Chrome, launch it over its
// pipe, talk to it, and the four `X_CDP_*` refusals. Its own entry, off the `.` barrel: a caller
// that only launches (`@ultimat3/testing`'s e2e driver, `x shot`) loads no job, storage or scrape
// module for it. `pdf()` on the barrel prints through the same launcher.

export type {
  CdpConnection,
  CdpConnectionOptions,
  CdpEventListener,
  CdpResult,
  CdpTransport,
} from './cdp-connection';
export { cdpConnect, cdpConnectOver } from './cdp-connection';
export type { CdpErrorCode } from './cdp-error-codes';
export { CDP_ERROR_CODES, CDP_ERROR_TITLES } from './cdp-error-codes';
export type {
  CdpLaunchAttempt,
  CdpTargetGone,
  CdpTimeoutObservation,
  CdpTimeoutReading,
} from './cdp-errors';
export {
  CdpBrowserMissingError,
  CdpCallFailedError,
  CdpLaunchFailedError,
  CdpTimeoutError,
} from './cdp-errors';
export type { CdpWire, FoundChromeOptions, LaunchedBrowser, LaunchOptions } from './cdp-launch';
export {
  BROWSER_LIFETIME_MS,
  CHROME_CANDIDATES,
  CHROME_PATH_ENV,
  CLOSE_GRACE_MS,
  CONTAINER_CHROME_ARGS,
  chromeCandidates,
  chromeLaunchFlags,
  defaultWire,
  findChrome,
  LAUNCH_ATTEMPTS,
  LAUNCH_BUDGET_MS,
  LAUNCH_REAP_MS,
  LAUNCH_TIMEOUT_MS,
  launchChrome,
  launchFoundChrome,
} from './cdp-launch';
export { LAUNCHED_CLOSE_MS } from './cdp-launch-attempt';
