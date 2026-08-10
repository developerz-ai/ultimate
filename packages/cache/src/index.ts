// Public API of @ultimat3/cache. Explicit, no `export *`.

export type { CacheHeaderOptions, CdnTierOptions, PurgeDriver } from './cdn';
export {
  cacheHeaders,
  cloudflarePurgeDriver,
  createCdnTier,
  fastlyPurgeDriver,
  noopPurgeDriver,
} from './cdn';
export type { CacheErrorCode } from './errors';
export {
  CACHE_ERROR_CODES,
  CACHE_ERROR_TITLES,
  CacheDriverUnavailableError,
  CacheNotImplementedError,
  CacheTagUnknownError,
  CacheTooLargeError,
} from './errors';
export type { CacheDependent, DependentKind } from './graph';
export {
  dependentsOf,
  dependentsOfKind,
  graphSize,
  graphSnapshot,
  registerDependent,
  resetGraph,
  unregisterDependent,
} from './graph';
export type { InvalidationReport, Revalidator } from './invalidate';
export {
  invalidateTags,
  invalidateWireTags,
  registeredTiers,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
export type { LruOptions, LruStats } from './lru';

export { createLruTier, estimateBytes, LruCache } from './lru';
export { clearMemo, createMemoTier, memoSize } from './memo';
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
export type {
  CacheEntry,
  CacheSetOptions,
  CacheStack,
  CacheTier,
  TierInvalidation,
  TierName,
} from './tiers';
export { createCacheStack, isExpired, nowMs, sortTiers, TIER_ORDER } from './tiers';
