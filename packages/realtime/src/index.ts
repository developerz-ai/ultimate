// Public API. Explicit, tier by tier: channels, live queries, local-first sync, plus the wire and
// the server/client halves that carry all three.

// ---- the client's one stateless piece, reusable against an app's own store ----------------------
export { applyPatches, orderAfterPatches } from './apply-patches';
export {
  type ChangeBufferOptions,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_BUFFER_BYTES_PER_QUERY,
  RingChangeBuffer,
} from './change-buffer';
// ---- tier 2: live queries ----------------------------------------------------------------------
export {
  type ChangeEvent,
  type ChangeFeed,
  type ChangeFeedStartOptions,
  type ChangeOp,
  formatLsn,
  InMemoryChangeFeed,
  type InMemoryChangeFeedOptions,
  PgLogicalReplicationFeed,
  type PgLogicalReplicationOptions,
  parseLsn,
} from './changefeed';
export {
  type ChangeFeedSelection,
  DEFAULT_REPLICATION_PUBLICATION,
  DEFAULT_REPLICATION_SLOT,
  REPLICATION_ENV_KEYS,
  type ReplicationEnvironment,
  replicatorLockKey,
  type SelectChangeFeedOptions,
  selectChangeFeed,
} from './changefeed-env';
// ---- tier 1: channels + presence ---------------------------------------------------------------
export {
  ChannelHub,
  type ChannelHubOptions,
  channelFrame,
  DEFAULT_MAX_TOPICS_PER_NODE,
  type Topic,
  type TopicGuard,
  type TopicGuardArgs,
  type TopicGuardResult,
  topic,
} from './channel';
// ---- server + client halves -------------------------------------------------------------------
export {
  type ClientSocket,
  LiveClient,
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
  DIGEST_UNVERIFIED,
  defaultReconnectBudget,
  digestOf,
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
  verifyDigest,
} from './cursor';
// ---- errors ----------------------------------------------------------------------------------
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
  ReplicationFailedError,
  ReplicationProtocolError,
  ReplicatorSlotHeldError,
  SubscriptionLimitError,
  TopicForbiddenError,
  TransportProtocolError,
  TransportUnavailableError,
} from './errors';
export {
  InProcessTransport,
  type InProcessTransportOptions,
  subjectMatches,
  type Transport,
  type TransportHandler,
  type TransportSet,
  type TransportSetEntry,
  type TransportSubscription,
} from './fanout';
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
  fnv1a,
  isJsonObject,
  isRow,
  type JsonObject,
  type JsonValue,
  type Row,
  type RowOp,
  type RowPatch,
} from './json';
export type {
  LiveQueryDefinition,
  LiveSubscription,
  SnapshotResult,
} from './live-contract';
export { type LiveDefinitionOptions, liveQueryDefinition } from './live-definition';
export {
  DEFAULT_MAX_ENTRIES,
  LiveQueryRegistry,
  type LiveQueryRegistryOptions,
} from './live-query';
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
  applyToWindow,
  type BridgeResult,
  bridgeChange,
  canAffect,
  type IncrementalMatcher,
  matcherFor,
  NO_CHANGE,
  normalizePatch,
  patchFromChange,
  type SubscriptionShape,
  toBridgeResult,
} from './matcher-bridge';
// ---- the production bus -------------------------------------------------------------------------
export {
  DEFAULT_NATS_PORT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type NatsClient,
  type NatsClientOptions,
  type NatsConnect,
  type NatsHeaders,
  type NatsMessage,
  type NatsMessageHandler,
  type NatsRequestManyOptions,
  type NatsRequestOptions,
  type NatsSubscription,
  type NatsTarget,
  parseNatsUrl,
} from './nats-client';
export { FakeNatsBroker, type FakeNatsOptions, fakeNatsConnect } from './nats-fake';
export {
  assertBucket,
  assertServerVersion,
  ensureKvBucket,
  type JsError,
  type KvRecord,
  kvGet,
  kvLast,
  kvStream,
  kvSubject,
  kvWrite,
} from './nats-jetstream';
export { decodeToken, encodeToken, NatsKvSet, type NatsKvSetOptions } from './nats-kv';
export { openNatsClient } from './nats-lib-client';
export { NatsTransport, type NatsTransportOptions } from './nats-transport';
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
export { PgAdvisoryLock, type PgAdvisoryLockOptions } from './pg-advisory-lock';
// ---- the postgres replication path ------------------------------------------------------------
export { camel, entityRow } from './pg-entity-row';
export {
  changeLsn,
  commitPositionOf,
  type ReplicationStreamStats,
} from './pg-replication';
export { bunPgStream, type PgTarget, parsePgUrl, type SslMode } from './pg-socket';
export type { PgStream } from './pg-wire';
export {
  type PgColumn,
  PgOutputDecoder,
  type PgOutputMessage,
  type PgRelation,
} from './pgoutput';
export { authorizeWithPolicy, type GateOptions, visibleWithPolicy } from './policy-gate';
export {
  DEFAULT_MAX_PRESENCE_MEMBERS,
  PRESENCE_KEY_PREFIX,
  PRESENCE_SWEEP_PREFIX,
  type PresenceInput,
  type PresenceOptions,
  PresenceRegistry,
  type PresenceRoster,
  presenceFrame,
} from './presence';
/** The typed projection: one query bound to one named hook, `useLiveFeed({ orgId })`. */
export {
  type LiveQueryHook,
  type LiveQuerySource,
  liveHookFor,
} from './query-hook';
export {
  createEntry,
  fillWindow,
  orgIdOf,
  type PendingRead,
  type QueryEntry,
  refillWindowInLane,
} from './query-window';
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
export {
  type AdvisoryLock,
  CHANGE_SUBJECT_PREFIX,
  type ChangeEnvelope,
  changeSubject,
  createReplicator,
  InMemoryAdvisoryLock,
  normalize,
  parseChange,
  parseEnvelope,
  type Replicator,
  type ReplicatorOptions,
  type ReplicatorStats,
  SeqGapDetector,
} from './replicator';
export {
  actorIdOf,
  CLOSE,
  DEFAULT_FRAME_BURST,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_FRAMES_PER_SECOND,
  idleSweepPeriodMs,
  SocketRegistry,
  type SocketRegistryOptions,
  SyncSocket,
  type SyncSocketOptions,
  type WsLike,
} from './socket';
export type {
  GateFailed,
  GateStage,
  RowDenied,
  Subscriber,
  SubscriberGateOptions,
} from './subscriber-gate';
export {
  GrantBook,
  type GrantSweepDeps,
  type GrantSweepResult,
  type SyncAuthenticator,
  type SyncGrant,
  sweepGrants,
} from './sync-auth';
export {
  createFrameRouter,
  type FrameRouter,
  type FrameRouterOptions,
  type MutationHandler,
} from './sync-frames';
export {
  type ListenOptions,
  listenSyncNode,
  type SyncListener,
} from './sync-listen';
export {
  createSyncNode,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_REAUTH_INTERVAL_MS,
  type SyncNode,
  type SyncNodeOptions,
  type SyncWs,
  type UpgradeTarget,
  type WsData,
} from './sync-node';
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
export {
  AcceptBudget,
  type AcceptBudgetOptions,
  type BackoffPolicy,
  backoffDelay,
  type DrainedSocket,
  type DrainPlanEntry,
  type DrainPlanOptions,
  defaultBackoff,
  drainPlan,
  type JitterMode,
  type ReconnectReason,
  type Rng,
  reconnectFrame,
  type Scheduler,
  timeoutScheduler,
} from './thundering-herd';
export {
  DEFAULT_PRESENCE_BUCKET,
  DEFAULT_PRESENCE_TTL_MS,
  type SelectTransportOptions,
  selectTransport,
  TRANSPORT_ENV_KEYS,
  type TransportEnvironment,
  type TransportSelection,
} from './transport-env';
