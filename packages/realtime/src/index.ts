// The CLIENT half of the public API — everything a browser island may bundle. Explicit, tier by
// tier: the wire, the hooks, the record store, the offline outbox and the reconnect vocabulary.
// Nothing here reaches `nats`, a Postgres socket or the sync node; those are `./server`, and
// `packages/cli/src/realtime-browser-barrel.test.ts` is the build error that keeps them apart.

// ---- the client's one stateless piece, reusable against an app's own store ----------------------
export { applyPatches, orderAfterPatches } from './apply-patches';
// ---- channels: the declaration is the only way to spell a topic, and the frames it rides --------
export {
  type Channel,
  type ChannelEntity,
  type ChannelInit,
  type ChannelParams,
  type ChannelRowLoader,
  type ChannelServerInit,
  channel,
} from './channel-decl';
// Presence rides a channel's `events`: the payload shape, and the one reader a client needs.
export { type PresenceEvent, type PresenceOp, readPresence } from './channel-presence';
// The client half of a channel an island holds — no entity, no policy (`channel-ref.ts`).
export { type ChannelHandle, channelRef, type Topic, topic } from './channel-ref';
// The process's channel table: what a hub serves by default. `describeChannels` is `./server`'s.
export { clearChannels, registeredChannels } from './channel-registry';
export type {
  ChannelAdopt,
  ChannelEventsFrame,
  ChannelRecordsFrame,
  ChannelRemove,
  ChannelSince,
  ChannelSubscribeTarget,
  ChannelWireFrame,
  ReplayGapFrame,
} from './channel-wire';
// ---- the hooks: every read and write a component makes -----------------------------------------
export type { ChannelHandlers, ChannelRef, ChannelState } from './client-channels';
// ---- the shapes a hook hands back ----------------------------------------------------------------
export type {
  LiveHandle,
  LiveQueryRef,
  SignalFactory,
  Unsubscribe,
} from './client-contract';
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
  LiveQueryUnknownError,
  LiveRowUnidentifiedError,
  NotImplementedError,
  ProtocolVersionError,
  REALTIME_ERROR_CODES,
  REALTIME_ERROR_TITLES,
  RealtimeError,
  type RealtimeErrorCode,
  RealtimeUninstalledError,
  RebaseConflictError,
  RecordRejectedError,
  ReplicaIdentityError,
  ReplicationFailedError,
  ReplicationProtocolError,
  ReplicatorSlotHeldError,
  ServerRenderLiveError,
  SubscriptionLimitError,
  SyncUnconfiguredError,
  TopicForbiddenError,
  TransportProtocolError,
  TransportUnavailableError,
  WindowReadTimeoutError,
} from './errors';
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
export { type LiveState, type Registration, RowWindows, unnamedType } from './live-rows';
// ---- offline: the durable store, the persisted records, the one outbox (plan 101 slice 12) ------
export {
  type LocalStore,
  MemoryLocalStore,
  openLocalStore,
  pageLocalStore,
  scopeKey,
} from './local-store-idb';
// ---- the offline outbox (wired over HTTP in plan 101 slice 12) ----------------------------------
export {
  type DrainReport,
  MemoryQueueStore,
  type MutationSender,
  type MutationStatus,
  OfflineQueue,
  type QueuedMutation,
  type QueueState,
  type QueueStore,
} from './offline-queue';
export {
  createOutbox,
  listenForDrain,
  type OutboxEntry,
  type PageOutbox,
  pageOutbox,
} from './page-outbox';
// ---- the page: one record store, one socket, installed by the island bootstrap ------------------
export { hasPageSocket, type SyncTarget } from './page-store';
export { installRealtime, type RealtimeInstall } from './reactivity';
export { persistedTypes, type RecordPersister, recordPersister } from './record-persister';
export {
  type RecordKey,
  type RecordListener,
  RecordStore,
  type RecordStoreOptions,
  recordKey,
} from './record-store';
export type { LocalTable, LocalTx, TableMap } from './record-tx';
// ---- the wire -------------------------------------------------------------------------------------
export {
  type AckFrame,
  decode,
  encode,
  FRAME_KINDS,
  FRAME_LIMITS,
  type Frame,
  type FrameKind,
  type HelloFrame,
  type PatchFrame,
  PROTOCOL_VERSION,
  type PresenceMember,
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
  BROWSER_RECONNECT_MAX_MS,
  backoffDelay,
  browserBackoff,
  defaultBackoff,
  type JitterMode,
  type ReconnectReason,
  type Rng,
  type Scheduler,
  timeoutScheduler,
} from './thundering-herd';
export {
  type ChannelAccessor,
  type PresenceAccessor,
  useChannel,
  usePresence,
} from './use-channel';
export { type Connection, useConnection } from './use-connection';
export {
  type Mutate,
  type MutationQueue,
  type MutatorLike,
  useMutation,
  useMutationQueue,
} from './use-mutation';
export { type QueryAccessor, type QueryOptions, type QueryRef, useQuery } from './use-query';
export { type RecordAccessor, type RecordsAccessor, useRecord, useRecords } from './use-record';
