/**
 * `@ultimat3/core/page` — the ONE light entry for browser code: the page handle, the principal
 * fence, the names a document, a service worker and an island agree on, and `UltimateError` with
 * the render helper a refusal's `fix:` needs. What it never carries is a titles TABLE: any barrel
 * import retains the anchored `core-error-codes.ts` and `schema-error-codes.ts`, and a browser
 * that loaded no table titles a code from its name. The barrel re-exports every name here;
 * `page-bundle.test.ts` fails if this entry ever grows a table back.
 */

// The client seam's own functions, for the hooks a browser island calls: the one transport, the
// URL rule, the principal-supersession reader, and the small helpers realtime's browser half uses.
// Each reaches no titles table — `page-bundle.test.ts` builds all of them together to prove it.
export { assertCoded } from './assert';
export type { AsyncState } from './async-state';
export type { JitterMode, Random } from './backoff';
export { backoffDelay } from './backoff';
export type { FetchLike, TransportRequest } from './client-dispatch';
export { BUILD_ID_HEADER, IDEMPOTENCY_HEADER } from './client-dispatch';
// Opt-in flight control: a typed client names `ClientFlight` as a TYPE and pays nothing; an island
// that wants the fence, dedup and retry calls `clientFlight` from here, never through the barrel.
export type { ClientFlight, ClientFlightOptions, ClientRetry } from './client-flight';
export { clientFlight } from './client-flight';
export type { ActionPathStyle } from './client-paths';
export { actionPath, queryPath, splitWords } from './client-paths';
export type { ActionPin, PinnedActionMethod } from './client-paths-pins';
export { renderedActionPin, renderedQueryPin } from './client-paths-pins';
// A typed client's own decode of a refusal: the body read, its title and request id carried, the
// retry class its status implies — all off the wire, so an island needs no titles table.
export { remoteTitleOf, withRequestId, withStatedDelay } from './client-problem';
export type { ClientScope } from './client-scope';
export { onRescope, rescope } from './client-scope';
export { clientStream } from './client-stream';
export { clientTransport } from './client-transport';
export { FRAMEWORK_CODE, problemOf, retryForStatus } from './client-wire';
export { notifyClientWrite, onClientWrite } from './client-writes';
export { type Clock, systemClock } from './clock';
export type { ConflictPolicy, Row } from './conflict-policy';
// Registry-free: it merges two rows and throws nothing, so the page's record store settles a
// write under a conflict policy without loading the error table.
export { resolveConflict } from './conflict-policy';
// The registry's one writer, for a package that titles its OWN codes in a browser chunk
// (`@ultimat3/realtime`'s `error-titles.ts`). A function, not a table: `errors.ts` already retains
// `error-codes.ts`, so this adds no module — and through the barrel it cost both anchored tables.
// `hasErrorCode` and `ERROR_DOCS_URL` read the registry `errors.ts` already retains; a package's
// browser-reachable error classes need them, `registerErrorRetry` beside `registerErrorCodes`.
export { ERROR_DOCS_URL, hasErrorCode, registerErrorCodes } from './error-codes';
export {
  renderCauseValue,
  renderFixShellArg,
  renderThrowable,
  stringField,
} from './error-render';
export { classifyThrown, registerErrorRetry } from './error-retry';
export type { UltimateErrorInit } from './errors';
export { deniedCallerFix, isUltimateError, UltimateError } from './errors';
export { fillWire } from './fill-wire';
export { finiteCount, finiteOption } from './finite-option';
export { isSuperseded } from './generation-fence';
export { uuidV7 } from './ids';
export { isJsonObject } from './json-object';
export type { OutboxDrainMessage } from './outbox-drain';
export { OUTBOX_DRAIN_MESSAGE } from './outbox-drain';
export {
  APP_UPDATE_MESSAGE,
  CLIENT_BUILD_META,
  CLIENT_NAVIGATION_HEADER,
  CLIENT_NAVIGATION_LOCATION_HEADER,
  CLIENT_NAVIGATION_SCOPE_HEADER,
  CLIENT_NAVIGATION_SURFACE_HEADER,
  CLIENT_PATH_STYLE_META,
  CLIENT_PERSIST_META,
  CLIENT_PINS_META,
  CLIENT_SCOPE_HEADER,
  CLIENT_SCOPE_META,
  CLIENT_SYNC_META,
  CLIENT_SYNC_WORKER_META,
} from './page-meta';
export type { RecordEnvelope, RecordRows } from './record-envelope';
export { decodeRecordEnvelope, RECORDS_HEADER } from './record-envelope';
export type { PageClient, RecordSink } from './record-sink';
export { pageClient } from './record-sink';
export { fillTemplate, templateParams } from './route-path-template';
export { onSessionLost, sessionIsLost } from './session-lost';
// The key the theme boot script reads and the toggle island writes.
export { THEME_STORAGE_KEY } from './theme-storage';
// A poll a hidden tab and a lost session stop: here, so an island polling reaches no realtime.
export type { VisibleIntervalOptions } from './visible-interval';
export { visibleInterval } from './visible-interval';
// What `clientTransport` revives a read's instants by: the header the server names them in.
export { DATES_HEADER, reviveWireDates } from './wire-dates';
// A write's public name, so the page's store can recognise the `records` frame its own write made.
export { isWriteDigest, WRITE_DIGEST_LENGTH, writeDigest } from './write-digest';
