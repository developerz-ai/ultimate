// Public API of @ultimat3/scraping. Explicit re-exports only — and complete enough that a third
// party can implement `ScrapeDriver` from this list alone. If a driver author needs a deep import,
// the seam is not a seam.

export type { ActionabilityState, ActionabilityWait } from './actionability';
export { awaitActionable } from './actionability';
export type { ArtifactRef, ArtifactWriter, ArtifactWriterInit } from './artifacts';
export {
  createArtifactWriter,
  DEFAULT_CONTENT_TYPE,
} from './artifacts';
export type {
  AuthContext,
  PromptHandler,
  PromptRequest,
  ScrapeAuth,
} from './auth';
export { burnSession, createPrompt, ensureAuthenticated, restorableSession } from './auth';
export { browserRecord } from './browser-record';
export type { CaptureClip, CaptureFraming } from './capture-clip';
export { assertCaptureFraming } from './capture-clip';
export type {
  CdpBrowserLike,
  CdpFrameLike,
  CdpKeyboardLike,
  CdpLauncherLike,
  CdpPageLike,
  CdpRequestLike,
  CdpScreenshotOptions,
  CdpSessionLike,
} from './cdp-port';
export { snapshotExpression } from './cdp-snapshot';
export type { CdpTargetInit } from './cdp-target';
export { CDP_DRIVER, cdpTarget } from './cdp-target';
export type { Deadline, ScrapeClock, TestScrapeClock } from './clock';
export { deadline, systemScrapeClock, testClock, throwIfAborted } from './clock';
export type { ColorScheme } from './color-scheme';
export { COLOR_SCHEMES, isColorScheme } from './color-scheme';
export { cookieHeaderFor } from './cookie-scope';
export type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
export { resetScrapeDriver, scrapeDriver, setScrapeDriver } from './driver';
export type { BrowserOptions, LocalBrowserOptions, RemoteBrowserOptions } from './driver-cdp';
export { localBrowser, remoteBrowser } from './driver-cdp';
export type { FakeBrowserOptions, FakePageOptions, FakePages } from './driver-fake';
export { FAKE_DRIVER, FAKE_PAGE_URL, fakeBrowser, fakePage, recordingsOf } from './driver-fake';
export type { FixtureBrowserOptions } from './driver-fixture';
export { FIXTURE_DRIVER, fixtureBrowser } from './driver-fixture';
export {
  authFailed,
  blocked,
  bodyTooLarge,
  browserUnreachable,
  cdpAttachFailed,
  downloadTimeout,
  driverUnknown,
  fixtureMissing,
  fixtureStale,
  hostBlocked,
  httpFailed,
  keyInvalid,
  notActionable,
  outputInvalid,
  pageCrashed,
  profileLocked,
  promptUnanswered,
  recoverRefused,
  redirectLoop,
  remoteRequired,
  robotsDisallowed,
  scrapeNotImplemented,
  scrapeTimeout,
  secretExposed,
  selectorMissing,
  sessionExpired,
  wedged,
  yieldCollapsed,
} from './error-throws';
export type { ScrapeErrorCode, ScrapeErrorInit, ScrapeOwnedErrorCode } from './errors';
export {
  isRetryableScrapeError,
  isScrapeError,
  SCRAPE_BORROWED_ERROR_CODES,
  SCRAPE_ERROR_CODES,
  SCRAPE_ERROR_RETRY,
  SCRAPE_ERROR_TITLES,
  SCRAPE_OWNED_ERROR_CODES,
  ScrapeError,
} from './errors';
export type { ScrapeEventFields, StepEvent } from './events';
export type { YieldCheck, YieldExpectation, YieldGuardInput, YieldHistory } from './expect';
export {
  guardYield,
  MIN_BASELINE_RUNS,
  median,
  memoryYieldHistory,
} from './expect';
export { BURNS_SESSION, errorCode, NEVER_RETRIED } from './failures';
export type { HostDecision, HostRule } from './hosts';
export { ANY_HOST, hostDecision, hostMatches } from './hosts';
export { queryHtml } from './html-query';
export type { MarkupRequest } from './html-requests';
export type { HtmlTargetInit, RecordingLookup } from './html-target';
export { htmlTarget } from './html-target';
export type { HttpRequestInit, HttpTransportInit, ScrapeHttp, ScrapeResponse } from './http';
export { DEFAULT_HTTP_MAX_BYTES, httpOverFetch, responseOver } from './http';
export type { HttpRecordingLookup, RecordedHttpInit } from './http-recorded';
export { httpRecordingsOf, recordedHttp } from './http-recorded';
export type { RedirectHop } from './http-redirect';
export { MAX_REDIRECT_HOPS } from './http-redirect';
export type { InterceptRules, InterceptVerdict } from './intercept';
export { interceptVerdict } from './intercept';
export type { KeyChord, KeyModifier } from './key-chord';
export { KEY_MODIFIERS, parseKeyChord } from './key-chord';
export type { OfflineSessionInit } from './offline-session';
export { openOfflineSession } from './offline-session';
export type {
  AccessibilityOptions,
  CaptureRequest,
  DownloadRequest,
  ElementValue,
  ScrapeFrame,
  ScrapePage,
  WaitOptions,
} from './page';
export type { PageContext } from './page-over-target';
export { pageOverTarget } from './page-over-target';
export type { Pacer } from './rate';
export { createPacer } from './rate';
export type { HttpRecording, PageRecording } from './recording';
export {
  httpRecordingSchema,
  pageRecordingSchema,
  parseHttpRecording,
  parseRecording,
} from './recording';
export type { AgentRecovery, Recovery, RecoveryAttempt, RecoveryHook } from './recover';
export { runRecovery } from './recover';
export type {
  ConsoleLine,
  ConsoleRing,
  NetworkEntry,
  NetworkRing,
  PageError,
  PageErrorRing,
  ResourceType,
  Ring,
} from './rings';
export {
  createRing,
  MAX_PAGE_ERROR_CHARS,
  pageErrorEntry,
  RESOURCE_TYPES,
} from './rings';
export type { RobotsFetch, RobotsGate, RobotsGateInit, RobotsPolicy, RobotsRules } from './robots';
export { createRobotsGate, parseRobots, robotsAllows } from './robots';
export type { RobotsFetchInit } from './robots-fetch';
export {
  DEFAULT_ROBOTS_MAX_BYTES,
  DEFAULT_ROBOTS_TIMEOUT_MS,
  robotsFetcher,
} from './robots-fetch';
export type {
  ScrapeArtifacts,
  ScrapeDefinition,
  ScrapeReport,
  ScrapeRunArgs,
} from './scrape';
export { scrape } from './scrape';
export { DEFAULT_PAGE_TIMEOUT_MS, runScrape } from './scrape-run';
export type { ScrapeSecrets, SecretResolver } from './secrets';
export {
  createSecretBag,
  MIN_REDACTABLE_LENGTH,
  redactSecrets,
  safeConsole,
  safeHtml,
  safeNetwork,
  safePageErrors,
} from './secrets';
export type { ScrapeSessionStore, SessionSnapshot, SessionState } from './session-state';
export {
  memorySessionStore,
  parseSessionState,
  sessionDigest,
  sessionKeyFor,
  storageSessionStore,
} from './session-state';
export type {
  AxNode,
  CaptureOptions,
  ElementBox,
  ElementSnapshot,
  FrameRef,
  GotoOptions,
  ScrapeCookie,
  ScrapeDownloadFile,
  ScrapeTarget,
} from './target';
export type { WedgeGuard, WedgeGuardInit } from './watchdog';
export { DEFAULT_GRACE_MS } from './watchdog';
