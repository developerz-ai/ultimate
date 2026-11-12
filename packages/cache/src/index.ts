// Public API of @ultimat3/cache. Explicit, no `export *`.

// The `cache.*` payloads are core's (the bus is tier 0); re-exported, never a second shape.
export type {
  CacheInvalidateEvent,
  CacheLookupEvent,
  CacheTierFailureEvent,
} from '@ultimat3/core';
export type { CacheHeaderOptions, CdnTierOptions, PurgeDriver } from './cdn';
export {
  cacheHeaders,
  cdnTier,
  isNoopPurgeDriver,
  noopPurgeDriver,
  surrogateKeys,
} from './cdn';
export type { CacheErrorCode } from './errors';
export {
  CacheDriverUnavailableError,
  CachePurgeFailedError,
  CacheTooLargeError,
  CacheValueUnencodableError,
} from './errors';
export type { CacheFence, FenceScope } from './fence';
export { markInvalidated, sampleFence } from './fence';
export type { CacheDependent, DependentKind } from './graph';
export {
  dependentsOf,
  dependentsOfKind,
  isolateGraph,
  registerDependent,
  resetGraph,
  unregisterDependent,
} from './graph';
export type {
  InvalidationBroadcast,
  InvalidationReport,
  Revalidator,
  TagRevalidator,
} from './invalidate';
export {
  EVERY_TAG,
  FLUSH_ALL_TAG,
  flushProcessTiers,
  invalidateTags,
  invalidateWireTags,
  isolateTiers,
  purgeEdgeAgain,
  receiveInvalidationBroadcast,
  registeredTiers,
  registerInvalidationBroadcast,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
export type { LruOptions } from './lru';
export { estimateBytes, LruCache, lruTier } from './lru';
export { MEMO_MAX_BYTES, memoTier } from './memo';
export type { MemoFlights } from './memo-flights';
export { memoFlights } from './memo-flights';
export { memoPerRequest } from './memo-per-request';
export type { CloudflarePurgeOptions } from './purge-cloudflare';
export { CLOUDFLARE_API_URL, cloudflarePurgeDriver } from './purge-cloudflare';
export type { PurgeEnvironment, PurgeSelection } from './purge-env';
export { selectPurgeDriver } from './purge-env';
export type { FastlyPurgeOptions } from './purge-fastly';
export { fastlyPurgeDriver } from './purge-fastly';
export type { PurgeFetch } from './purge-http';
export type { RedisLike, RedisTierOptions } from './redis';
export { namespaceFor, redisTier } from './redis';
export type {
  InvalidationBus,
  InvalidationSubscription,
  PubSubListener,
  RedisPublisherLike,
  RedisPubSubOptions,
  RedisSubscriberLike,
} from './redis-pubsub';
export { redisPubSub, redisPubSubAt } from './redis-pubsub';
export type {
  Embedding,
  SemanticCache,
  SemanticCacheOptions,
  SemanticHit,
  SemanticRememberOptions,
} from './semantic';
export { memorySemanticCache } from './semantic';
export type { CacheTag, CacheTagRegistry, TagFactory } from './tags';
export {
  assertKnownTags,
  declareTags,
  isolateDeclaredTags,
  knownTags,
  parseTag,
  resetDeclaredTags,
  serializeTag,
  serializeTags,
  tag,
  tagKeys,
  tagMatches,
  tagsIntersect,
} from './tags';
export type { TierOperation } from './tier-failures';
export { bestEffort } from './tier-failures';
export type { FenceVerdict, TierFence } from './tier-fence';
export type {
  CacheEntry,
  CacheSetOptions,
  CacheStack,
  CacheStackOptions,
  CacheTier,
  Rng,
  TierInvalidation,
  TierLabel,
  TierName,
  TtlJitter,
  TtlScope,
} from './tiers';
export {
  assertFiniteCapacity,
  assertFiniteDurationMs,
  assertFiniteSimilarityFloor,
  assertTtl,
  cacheStack,
  DEFAULT_LOAD_DEADLINE_MS,
  DEFAULT_TTL_JITTER_FRACTION,
  isExpired,
  nowMs,
  sortTiers,
} from './tiers';
