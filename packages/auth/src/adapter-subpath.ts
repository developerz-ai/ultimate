// `@ultimat3/auth/adapter` — auth's three `ADAPTER_PORTS` rows (`authLimiter`, `totpReplay`,
// `authServerStore`): interfaces, installers and resets, never on the `.` barrel, so an app swaps
// each one way — `apps/<app>/runtime.ts`. Not `src/adapter.ts`: that is the `AuthAdapter` seam's.

export type {
  AuthServerStore,
  DeviceDecision,
  RefreshRotation,
} from './authorization-server-store';
export type {
  AuthCodeRecord,
  AuthGrantRecord,
  AuthServerClient,
  AuthTokenRecord,
  DeviceCodeRecord,
} from './authorization-server-types';
export type { AuthLimiterFactory, TotpReplayFactory } from './limiter-install';
export {
  installAuthLimiters,
  installTotpReplay,
  resetAuthLimiters,
  resetTotpReplay,
} from './limiter-install';
export type { TotpReplayGuard } from './mfa';
export type { AuthLimiter, AuthLimiterScope, AuthRateLimitPolicy } from './rate-limit';
