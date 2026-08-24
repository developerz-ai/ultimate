// The CLIENT half of the public API — everything a browser island may bundle. Explicit, tier by
// tier: the wire, the hooks, the identity map, the offline queue and the reconnect vocabulary.
// Nothing here reaches `nats`, a Postgres socket or the sync node; those are `./server`, and
// `packages/cli/src/realtime-browser-barrel.test.ts` is the build error that keeps them apart.

// ---- the client's one stateless piece, reusable against an app's own store ----------------------
export { applyPatches, orderAfterPatches } from './apply-patches';
// ---- server + client halves -------------------------------------------------------------------
export {
  type ClientSocket,
  LiveClient,
  type LiveClientLike,
  type LiveClientOptions,
  type LiveHandle,
  type LiveQueryRef,
  type LiveState,
  type MutatorRef,
  type SignalFactory,
  type Unsubscribe,
} from './client';
// ---- reconnect ----------------------------------------------------------------------------------
export {
  advance,
  CURSOR_ID_LIMIT,
  defaultReconnectBudget,
  type LiveCursor,
  makeCursor,
  type ReconnectBudget,
  type ResumeDecision,
  type ResumeDeps,
  type ResumeReason,
  type ResumeResult,
  type ResumeSource,
  resumeFrom,
  shouldResnapshot,
} from './cursor';
// ---- errors: one vocabulary for both halves, because every code reaches the wire ---------------
export {
  CursorStaleError,
  FrameRateLimitError,
  LiveClientMissingError,
  LiveQueryUnknownError,
  LiveRowUnidentifiedError,
  NotImplementedError,
  ProtocolVersionError,
  QueryNotSubscribableError,
  REALTIME_ERROR_CODES,
  REALTIME_ERROR_TITLES,
  RealtimeError,
  type RealtimeErrorCode,
  RebaseConflictError,
  ReplicaIdentityError,
  ReplicationFailedError,
  ReplicationProtocolError,
  ReplicatorSlotHeldError,
  ServerRenderLiveError,
  SubscriptionLimitError,
  TopicForbiddenError,
  TransportProtocolError,
  TransportUnavailableError,
  WindowReadTimeoutError,
} from './errors';
// ---- the client hooks --------------------------------------------------------------------------
export {
  type ConflictLike,
  type Connection,
  clearLiveClient,
  hasLiveClient,
  type LiveInput,
  type LiveRows,
  type Mutate,
  type MutationQueue,
  type MutatorLike,
  setLiveClient,
  useConnection,
  useLive,
  useMutation,
  useMutationQueue,
} from './hooks';
// ---- the client's single source of truth: one row per (entity, id) ------------------------------
export {
  type IdentityListener,
  IdentityMap,
  privateScope,
  type RowKey,
  type RowScope,
  rowKey,
} from './identity-map';
// ---- shared value domain ---------------------------------------------------------------------
export {
  changedColumns,
  isJsonObject,
  isRow,
  type JsonObject,
  type JsonValue,
  type Row,
  type RowOp,
  type RowPatch,
} from './json';
export { type Registration, RowWindows } from './live-rows';
// ---- tier 3: local-first ------------------------------------------------------------------------
export {
  createOpfsLocalStore,
  type LocalStore,
  type LocalTable,
  type LocalTx,
  MemoryLocalStore,
  type OpfsLocalStoreOptions,
  type TableMap,
} from './local-store';
export {
  type DrainReport,
  MemoryQueueStore,
  type MutationSender,
  type MutationStatus,
  mutateFrame,
  OfflineQueue,
  type QueuedMutation,
  type QueueState,
  type QueueStore,
} from './offline-queue';
/** The typed projection: one query bound to one named hook, `useLiveFeed({ orgId })`. */
export {
  type LiveQueryHook,
  type LiveQuerySource,
  liveHookFor,
} from './query-hook';
export {
  type ConflictStrategy,
  type CustomMerge,
  custom,
  type MergeArgs,
  type RebaseEntry,
  RebaseLog,
  type ReconcileOptions,
  type ReconcileResult,
  rebaseFrame,
  reconcile,
  type ServerAck,
  strategyName,
} from './rebase';
// ---- what a LiveClient IS on the server: it serves the first render and opens no socket --------
export { serverRenderLiveClient } from './server-render-client';
// ---- the wire -------------------------------------------------------------------------------------
export {
  type AckFrame,
  type ConflictStrategyName,
  decode,
  encode,
  FRAME_KINDS,
  FRAME_LIMITS,
  type Frame,
  type FrameKind,
  type HelloFrame,
  type MutateFrame,
  type PatchFrame,
  PROTOCOL_VERSION,
  type PresenceFrame,
  type PresenceMember,
  type RebaseFrame,
  type ReconnectFrame,
  type SnapshotFrame,
  type SubscribeFrame,
  type SubscribeTarget,
  toWireError,
  type UpdateAvailableFrame,
  type WireError,
} from './sync-protocol';
// ---- the client's own reconnect: the backoff it computes and the timer it arms -----------------
export {
  type BackoffPolicy,
  backoffDelay,
  defaultBackoff,
  type JitterMode,
  type ReconnectReason,
  type Rng,
  type Scheduler,
  timeoutScheduler,
} from './thundering-herd';
