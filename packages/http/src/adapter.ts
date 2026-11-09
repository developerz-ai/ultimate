// `@ultimat3/http/adapter` — the rate-limit store port: the interface a driver implements, the
// errors it throws, and the boot's installer. The installer lives here and never on the `.` barrel
// so an app has exactly one way to choose a store: `rateLimitStore` in `apps/<app>/runtime.ts`.

export type { Bucket, RateLimitDecision, RateLimitScope, RateLimitStore } from './rate-limit';
export { rateLimitStoreUnavailable } from './rate-limit-errors';
export {
  clearDefaultRateLimitBuckets,
  installRateLimitStore,
  resetRateLimitStore,
  withScratchRateLimitStore,
} from './rate-limit-installed';
export type { RateLimitPeek } from './rate-limit-peek';
export { RATE_LIMIT_STORE_DEADLINE_MS } from './rate-limit-store-deadline';
