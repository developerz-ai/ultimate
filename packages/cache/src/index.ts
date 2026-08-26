// Public API of @ultimat3/cache. Explicit, no `export *`.

export type { CacheHeaderOptions, CdnTierOptions, PurgeDriver } from './cdn';
export { cacheHeaders, createCdnTier, isNoopPurgeDriver, noopPurgeDriver } from './cdn';
export type { CacheErrorCode } from './errors';
export {
  CACHE_ERROR_CODES,
  CACHE_ERROR_TITLES,
  CacheDriverUnavailableError,
  CacheJitterInvalidError,
  CacheLimitInvalidError,
  CachePurgeFailedError,
  CacheTagUnknownError,
  CacheTooLargeError,
  CacheTtlInvalidError,
} from './errors';
export type { CacheFence, FenceScope } from './fence';
export { FENCE_MEMORY, markInvalidated, sampleFence } from './fence';
export type { CacheDependent, DependentKind } from './graph';
export {
  dependentsOf,
  dependentsOfKind,
  graphSize,
  graphSnapshot,
  isolateGraph,
  registerDependent,
  resetGraph,
  unregisterDependent,
} from './graph';
export type {
  InvalidationBroadcast,
  InvalidationEvent,
  InvalidationReport,
  Revalidator,
} from './invalidate';
export {
  invalidateTags,
  invalidateWireTags,
  isolateTiers,
  receiveInvalidationBroadcast,
  recentInvalidations,
  registeredTiers,
  registerInvalidationBroadcast,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
export type { LruOptions, LruStats } from './lru';

export { createLruTier, estimateBytes, LruCache } from './lru';
export { clearMemo, createMemoTier, memoSize } from './memo';
export type { CloudflarePurgeOptions } from './purge-cloudflare';
export {
  CLOUDFLARE_API_URL,
  CLOUDFLARE_MAX_TAGS_PER_REQUEST,
  cloudflarePurgeDriver,
} from './purge-cloudflare';
export type { PurgeEnvironment, PurgeSelection } from './purge-env';
export { CDN_PURGE_ENV_KEYS, selectPurgeDriver } from './purge-env';
export type { FastlyPurgeOptions } from './purge-fastly';
export { FASTLY_API_URL, FASTLY_MAX_KEYS_PER_REQUEST, fastlyPurgeDriver } from './purge-fastly';
export type { PurgeFetch } from './purge-http';
export { DEFAULT_PURGE_TIMEOUT_MS } from './purge-http';
export type { RedisLike, RedisTierOptions } from './redis';
export {
  createRedisTier,
  namespaceFor,
  REDIS_INVALIDATE_SCRIPT,
  REDIS_TAG_MEMBER_SCRIPT,
} from './redis';
export type {
  Embedding,
  SemanticCache,
  SemanticCacheOptions,
  SemanticHit,
  SemanticRememberOptions,
} from './semantic';
export { cosineSimilarity, createMemorySemanticCache } from './semantic';
export type { FlightJoin, SingleFlight } from './single-flight';
export { createSingleFlight } from './single-flight';
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
  tagsFor,
  tagsIntersect,
} from './tags';
export type { TierFailure, TierOperation } from './tier-failures';
export { bestEffort, recentTierFailures } from './tier-failures';
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
  createCacheStack,
  DEFAULT_LOAD_DEADLINE_MS,
  DEFAULT_TTL_JITTER_FRACTION,
  isExpired,
  nowMs,
  sortTiers,
  TIER_ORDER,
} from './tiers';
