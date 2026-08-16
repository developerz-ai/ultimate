// Public API of @ultimat3/cache. Explicit, no `export *`.

export type { CacheHeaderOptions, CdnTierOptions, PurgeDriver } from './cdn';
export { cacheHeaders, createCdnTier, noopPurgeDriver } from './cdn';
export type { CacheErrorCode } from './errors';
export {
  CACHE_ERROR_CODES,
  CACHE_ERROR_TITLES,
  CacheDriverUnavailableError,
  CachePurgeFailedError,
  CacheTagUnknownError,
  CacheTooLargeError,
  CacheTtlInvalidError,
} from './errors';
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
export type { InvalidationEvent, InvalidationReport, Revalidator } from './invalidate';
export {
  invalidateTags,
  invalidateWireTags,
  isolateTiers,
  recentInvalidations,
  registeredTiers,
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
export { CDN_PURGE_ENV_KEYS, isNoopPurgeDriver, selectPurgeDriver } from './purge-env';
export type { FastlyPurgeOptions } from './purge-fastly';
export { FASTLY_API_URL, FASTLY_MAX_KEYS_PER_REQUEST, fastlyPurgeDriver } from './purge-fastly';
export type { PurgeFetch } from './purge-http';
export { DEFAULT_PURGE_TIMEOUT_MS } from './purge-http';
export type { RedisLike, RedisTierOptions } from './redis';
export { createRedisTier, REDIS_INVALIDATE_SCRIPT } from './redis';
export type {
  Embedding,
  SemanticCache,
  SemanticCacheOptions,
  SemanticHit,
  SemanticRememberOptions,
} from './semantic';
export { cosineSimilarity, createMemorySemanticCache } from './semantic';
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
  tagMatches,
  tagsFor,
  tagsIntersect,
} from './tags';
export type { TierFailure, TierOperation } from './tier-failures';
export { recentTierFailures } from './tier-failures';
export type {
  CacheEntry,
  CacheSetOptions,
  CacheStack,
  CacheStackOptions,
  CacheTier,
  TierInvalidation,
  TierName,
} from './tiers';
export { assertTtl, createCacheStack, isExpired, nowMs, sortTiers, TIER_ORDER } from './tiers';
