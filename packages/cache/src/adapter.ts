// `@ultimat3/cache/adapter`: cache's two `ADAPTER_PORTS` rows — `cacheTiers` (`CacheTier`) and
// `purge` (`PurgeDriver`) — as an adapter author needs them: the interfaces and the errors a tier or
// a purge driver raises. No installer: the boot READS both from `apps/<app>/runtime.ts`
// (`runtime-cache.ts`), and the shipped tiers and drivers stay on `.`.

export type { PurgeDriver } from './cdn';
export { CacheDriverUnavailableError, CachePurgeFailedError } from './errors';
export type { FenceScope } from './fence';
export type { CacheTag } from './tags';
export type { FenceVerdict, TierFence } from './tier-fence';
export type {
  CacheEntry,
  CacheSetOptions,
  CacheTier,
  TierInvalidation,
  TierName,
} from './tiers';
