// Public API of @ultimat3/scraping. Explicit re-exports only — and complete enough that a third
// party can implement `ScrapeDriver` from this list alone. If a driver author needs a deep import,
// the seam is not a seam.

export type { ActionabilityState, ActionabilityWait } from './actionability';
export { awaitActionable } from './actionability';
export type { ArtifactRef, ArtifactWriter, ArtifactWriterInit } from './artifacts';
export { artifactWriter } from './artifacts';
export type {
  AuthContext,
  PromptHandler,
  PromptInit,
  PromptRequest,
  ScrapeAuth,
} from './auth';
export { burnSession, ensureAuthenticated, restorableSession, scrapePrompt } from './auth';
export type { CaptureClip, CaptureFraming } from './capture-clip';
export { assertCaptureFraming } from './capture-clip';
export type {
  CdpBrowserLike,
  CdpBrowserSessionLike,
  CdpBrowserTargetLike,
  CdpFrameLike,
  CdpKeyboardLike,
  CdpLauncherLike,
  CdpPageLike,
  CdpPdfOptions,
  CdpScreenshotOptions,
  CdpSessionLike,
} from './cdp-port';
export type { CdpResolution, CdpResolver, CdpResolverRequest } from './cdp-resolver';
export { snapshotExpression } from './cdp-snapshot';
export type { CdpTargetInit } from './cdp-target';
export { cdpTarget } from './cdp-target';
export type { Deadline } from './clock';
export { deadline } from './clock';
export type { ColorScheme } from './color-scheme';
export { cookieHeaderFor } from './cookie-scope';
export type { ScrapeDriver, ScrapeSession, SessionInit } from './driver';
export { scrapeDriver } from './driver';
export type { BrowserOptions, LocalBrowserOptions, RemoteBrowserOptions } from './driver-cdp';
export { localBrowser, remoteBrowser } from './driver-cdp';
export type { FakeBrowserOptions, FakePageOptions, FakePages } from './driver-fake';
export { fakeBrowser, fakePage } from './driver-fake';
export type { FixtureBrowserOptions } from './driver-recorded';
export { fixtureBrowser } from './driver-recorded';
export {
  blocked,
  browserUnreachable,
  driverUnknown,
  httpFailed,
  promptUnanswered,
  remoteRequired,
  scrapeSessionExpired,
  wedged,
} from './error-throws';
export type { ScrapeErrorCode, ScrapeErrorInit } from './errors';
export {
  isScrapeError,
  SCRAPE_ERROR_CODES,
  SCRAPE_ERROR_RETRY,
  SCRAPE_OWNED_ERROR_CODES,
  ScrapeError,
} from './errors';
export type { AnswerPromptInput, EventPromptOptions } from './event-prompt';
export { answerPrompt, eventPrompt, promptEventName } from './event-prompt';
export type { YieldExpectation, YieldGuardInput, YieldHistory } from './expect';
export {
  guardYield,
  MIN_BASELINE_RUNS,
  median,
  memoryYieldHistory,
} from './expect';
export { BURNS_SESSION, errorCode, NEVER_RETRIED } from './failures';
export { queryHtml } from './html-query';
export type { HttpRequestInit, HttpTransportInit, ScrapeHttp, ScrapeResponse } from './http';
export { DEFAULT_HTTP_MAX_BYTES, httpOverFetch, responseOver } from './http';
export type { HttpRecordingLookup, RecordedHttpInit } from './http-recorded';
export { MAX_REDIRECT_HOPS } from './http-redirect';
export type { InterceptRules, InterceptVerdict } from './intercept';
export { interceptVerdict } from './intercept';
export type { KeyChord, KeyModifier } from './key-chord';
export { KEY_MODIFIERS, parseKeyChord } from './key-chord';
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
export type { PdfActionArgs, PdfActionOptions, PdfActionOutput } from './pdf-action';
export { pdf } from './pdf-action';
export type {
  ChromePdfRendererOptions,
  PdfBrowser,
  PdfRenderer,
  PdfRenderRequest,
} from './pdf-render';
export { chromePdfRenderer } from './pdf-render';
export type { PdfFormat, PdfLayout, PdfMarginMm, PdfRequest } from './pdf-request';
export { PDF_FORMATS } from './pdf-request';
export type { Pacer } from './rate';
export { scrapePacer } from './rate';
export type { HttpRecording, PageRecording } from './recording';
export type { RecoveryAttempt, RecoveryHook } from './recover';
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
  boundedRing,
  MAX_PAGE_ERROR_CHARS,
  pageErrorEntry,
  RESOURCE_TYPES,
} from './rings';
export type {
  RobotsAnswer,
  RobotsFetch,
  RobotsGate,
  RobotsGateInit,
  RobotsPolicy,
  RobotsUnreachable,
} from './robots';
export { robotsGate } from './robots';
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
  ScrapeSettled,
} from './scrape';
export { scrape } from './scrape';
export { DEFAULT_PAGE_TIMEOUT_MS, runScrape } from './scrape-run';
export type { ScrapeSecrets, SecretResolver } from './secrets';
export {
  MIN_REDACTABLE_LENGTH,
  redactSecrets,
  safeConsole,
  safeHtml,
  safeNetwork,
  safePageErrors,
  secretBag,
} from './secrets';
export type {
  ScrapeSessionStore,
  SessionSnapshot,
  SessionState,
  StorageSessionStoreOptions,
} from './session-state';
export {
  memorySessionStore,
  parseSessionState,
  recordVersion,
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
  PdfOptions,
  QueryOptions,
  ScrapeCookie,
  ScrapeDownloadFile,
  ScrapeTarget,
} from './target';
export { urlSecretValues } from './url-secrets';
export type { RunUsageMeter, ScrapeUsage, UsageMeter } from './usage';
export { usageMeter } from './usage';
export type { WedgeGuard } from './watchdog';
export { DEFAULT_GRACE_MS } from './watchdog';
