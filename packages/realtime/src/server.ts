// The SERVER half of the public API: the bus, the Postgres replication path, the sync node and the
// live-query registry it fans out through. Split from `index.ts` because `nats` require()s
// `stream/web` and the WAL decoder is a Postgres client — one barrel carrying both made the browser
// island `useLive` promises unbuildable. Every name here has exactly one home; the shared
// vocabulary (the wire, the errors, `Row`, the backoff) stays on `@ultimat3/realtime`.

// ---- the retained change window one node fans out from ------------------------------------------
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
export {
  createEntry,
  fillWindow,
  orgIdOf,
  type PendingRead,
  type QueryEntry,
  refillWindowInLane,
} from './query-window';
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
// ---- admission and drain: the node's half of the reconnect vocabulary ---------------------------
export {
  AcceptBudget,
  type AcceptBudgetOptions,
  type DrainedSocket,
  type DrainPlanEntry,
  type DrainPlanOptions,
  drainPlan,
  reconnectFrame,
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
