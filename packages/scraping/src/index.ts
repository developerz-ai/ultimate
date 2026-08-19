// Public API of @ultimat3/scraping. Explicit re-exports only — and complete enough that a third
// party can implement `ScrapeDriver` from this list alone. If a driver author needs a deep import,
// the seam is not a seam.

export type { ActionabilityState, ActionabilityWait } from './actionability';
export { actionabilityProblem, awaitActionable, DEFAULT_POLL_MS, isStable } from './actionability';
export type { ArtifactRef, ArtifactWriter, ArtifactWriterInit } from './artifacts';
export {
  contentTypeFor,
  createArtifactWriter,
  DEFAULT_ARTIFACT_PREFIX,
  DEFAULT_CONTENT_TYPE,
} from './artifacts';
export type {
  AuthContext,
  PromptHandler,
  PromptRequest,
  ScrapeAuth,
} from './auth';
export { burnSession, createPrompt, ensureAuthenticated, restorableSession } from './auth';
export type {
  CdpBrowserLike,
  CdpFrameLike,
  CdpLauncherLike,
  CdpPageLike,
  CdpRequestLike,
} from './cdp-port';
export { parseSnapshots, snapshotExpression } from './cdp-snapshot';
export type { CdpTargetInit } from './cdp-target';
export { CDP_DRIVER, cdpTarget } from './cdp-target';
export type { Deadline, ScrapeClock, TestScrapeClock } from './clock';
export { deadline, systemScrapeClock, testClock, throwIfAborted } from './clock';
export {
  cookieDomainMatches,
  cookieHeaderFor,
  cookiePathMatches,
  cookiesForUrl,
} from './cookie-scope';
export type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
export { resetScrapeDriver, scrapeDriver, setScrapeDriver } from './driver';
export type { BrowserOptions, LocalBrowserOptions, RemoteBrowserOptions } from './driver-cdp';
export { localBrowser, remoteBrowser } from './driver-cdp';
export type { FakeBrowserOptions, FakePageOptions, FakePages } from './driver-fake';
export { FAKE_DRIVER, FAKE_PAGE_URL, fakeBrowser, fakePage, recordingsOf } from './driver-fake';
export type { FixtureBrowserOptions } from './driver-fixture';
export { FIXTURE_DRIVER, fixtureBrowser, recordingFilename } from './driver-fixture';
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
  notActionable,
  outputInvalid,
  pageCrashed,
  profileLocked,
  promptUnanswered,
  recoverRefused,
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
export { scrapeLogger, withStepEvent } from './events';
export type { YieldCheck, YieldExpectation, YieldGuardInput, YieldHistory } from './expect';
export {
  DEFAULT_YIELD_WINDOW,
  guardYield,
  MIN_BASELINE_RUNS,
  median,
  memoryYieldHistory,
  yieldProblem,
} from './expect';
export { BURNS_SESSION, burnsSession, errorCode, NEVER_RETRIED, neverRetried } from './failures';
export type { HostDecision, HostRule } from './hosts';
export { ANY_HOST, hostDecision, hostMatches } from './hosts';
export { markupEnabled, markupVisible, queryHtml } from './html-query';
export type { MarkupRequest } from './html-requests';
export { markupRequests } from './html-requests';
export type { HtmlTargetInit, RecordingLookup } from './html-target';
export { htmlTarget } from './html-target';
export type { HttpRequestInit, HttpTransportInit, ScrapeHttp, ScrapeResponse } from './http';
export { DEFAULT_HTTP_MAX_BYTES, httpOverFetch, responseOver } from './http';
export type { HttpRecordingLookup, RecordedHttpInit } from './http-recorded';
export { httpRecordingFilename, httpRecordingsOf, recordedHttp } from './http-recorded';
export type { InterceptRules, InterceptVerdict } from './intercept';
export { interceptVerdict, refusalEntry } from './intercept';
export type { OfflineSessionInit } from './offline-session';
export { openOfflineSession } from './offline-session';
export type {
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
export { createPacer, DEFAULT_NAVIGATION_RATE } from './rate';
export type { HttpRecording, PageRecording } from './recording';
export {
  httpRecordingSchema,
  pageRecordingSchema,
  parseHttpRecording,
  parseRecording,
  splitDownload,
} from './recording';
export type { AgentRecovery, Recovery, RecoveryAttempt, RecoveryHook } from './recover';
export { runRecovery } from './recover';
export type {
  ConsoleLine,
  ConsoleRing,
  NetworkEntry,
  NetworkRing,
  ResourceType,
  Ring,
} from './rings';
export { createRing, DEFAULT_RING_CAPACITY, RESOURCE_TYPES } from './rings';
export type { RobotsFetch, RobotsGate, RobotsGateInit, RobotsPolicy, RobotsRules } from './robots';
export { createRobotsGate, DEFAULT_ROBOTS_AGENT, parseRobots, robotsAllows } from './robots';
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
  blankPasswordFields,
  createSecretBag,
  redactSecrets,
  SECRET_PLACEHOLDER,
  safeHtml,
} from './secrets';
export type { ScrapeSessionStore, SessionSnapshot, SessionState } from './session-state';
export {
  DEFAULT_SESSION_PREFIX,
  EMPTY_SESSION,
  memorySessionStore,
  parseSessionState,
  sessionDigest,
  sessionKeyFor,
  storageSessionStore,
} from './session-state';
export type {
  CaptureOptions,
  ElementBox,
  ElementSnapshot,
  FrameRef,
  GotoOptions,
  ScrapeCookie,
  ScrapeDownloadFile,
  ScrapeTarget,
} from './target';
export { ROOT_SELECTOR } from './target';
export type { WedgeGuard, WedgeGuardInit } from './watchdog';
export { createWedgeGuard, DEFAULT_GRACE_MS, DEFAULT_IDLE_MS } from './watchdog';
