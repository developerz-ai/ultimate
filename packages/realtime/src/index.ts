// Public API. Explicit, tier by tier: channels, live queries, local-first sync, plus the wire and
// the server/client halves that carry all three.

// ---- the client's one stateless piece, reusable against an app's own store ----------------------
export { applyPatches } from './apply-patches';
export { type ChangeBufferOptions, RingChangeBuffer } from './change-buffer';
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
  LiveClientMissingError,
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
// ---- shared value domain ---------------------------------------------------------------------
export {
  canonicalJson,
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
export { type LiveDefinitionOptions, liveQueryDefinition } from './live-definition';
export {
  type LiveQueryDefinition,
  LiveQueryRegistry,
  type LiveQueryRegistryOptions,
  type LiveSubscription,
  qidOf,
  type RowDenied,
  type SnapshotResult,
} from './live-query';
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
export type { NatsConnectOptions } from './nats-commands';
// ---- the production bus -------------------------------------------------------------------------
export {
  NatsConnection,
  type NatsConnectionOptions,
  type NatsMessageHandler,
  type NatsSubscription,
} from './nats-connection';
export { type FakeNatsOptions, FakeNatsServer, fakeNatsStream } from './nats-fake';
export {
  assertBucket,
  assertServerVersion,
  ensureKvBucket,
  type JsError,
  type KvRecord,
  kvGet,
  kvLast,
  kvSubject,
  kvWrite,
} from './nats-jetstream';
export { decodeToken, encodeToken, NatsKvSet, type NatsKvSetOptions } from './nats-kv';
export {
  type NatsHeaders,
  type NatsMessage,
  type NatsOperation,
  NatsProtocolParser,
  type NatsServerInfo,
} from './nats-protocol';
export {
  bunNatsStream,
  type NatsStream,
  type NatsTarget,
  natsStreamOver,
  parseNatsUrl,
} from './nats-socket';
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
  PRESENCE_KEY_PREFIX,
  type PresenceInput,
  type PresenceOptions,
  PresenceRegistry,
  presenceFrame,
} from './presence';
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
export {
  type AdvisoryLock,
  CHANGE_SUBJECT_PREFIX,
  changeSubject,
  createReplicator,
  InMemoryAdvisoryLock,
  normalize,
  parseChange,
  type Replicator,
  type ReplicatorOptions,
  type ReplicatorStats,
} from './replicator';
export {
  actorIdOf,
  CLOSE,
  SocketRegistry,
  type SocketRegistryOptions,
  SyncSocket,
  type SyncSocketOptions,
  type WsLike,
} from './socket';
export {
  createSyncNode,
  type ListenOptions,
  listenSyncNode,
  type MutationHandler,
  type SyncListener,
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
