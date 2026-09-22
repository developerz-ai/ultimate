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
export { invariant } from './assert';
export type { AsyncState } from './async-state';
export type { JitterMode, Random } from './backoff';
export { backoffDelay } from './backoff';
export type { FetchLike, TransportRequest } from './client-dispatch';
export { IDEMPOTENCY_HEADER } from './client-dispatch';
export { actionPath, queryPath, splitWords } from './client-paths';
export type { ClientScope } from './client-scope';
export { onRescope, rescope } from './client-scope';
export { clientTransport } from './client-transport';
export { type Clock, systemClock } from './clock';
export type { ConflictPolicy, Row } from './conflict-policy';
// Registry-free: it merges two rows and throws nothing, so the page's record store settles a
// write under a conflict policy without loading the error table.
export { resolveConflict } from './conflict-policy';
export { renderFixShellArg, renderThrowable, stringField } from './error-render';
export { classifyThrown } from './error-retry';
export type { UltimateErrorInit } from './errors';
export { isUltimateError, UltimateError } from './errors';
export { finiteCount, finiteOption } from './finite-option';
export { isSuperseded } from './generation-fence';
export { uuid } from './ids';
export { isJsonObject } from './json-object';
export type { OutboxDrainMessage } from './outbox-drain';
export { OUTBOX_DRAIN_MESSAGE } from './outbox-drain';
export {
  APP_UPDATE_MESSAGE,
  CLIENT_BUILD_META,
  CLIENT_PERSIST_META,
  CLIENT_SCOPE_META,
  CLIENT_SYNC_META,
  CLIENT_SYNC_WORKER_META,
} from './page-meta';
export type { RecordEnvelope, RecordRows } from './record-envelope';
export { decodeRecordEnvelope, RECORDS_HEADER } from './record-envelope';
export type { PageClient, RecordSink } from './record-sink';
export { pageClient } from './record-sink';
