// `@ultimat3/auth/adapter` — auth's three `ADAPTER_PORTS` rows (`authLimiter`, `totpReplay`,
// `authServerStore`) and the KDF gate's width: interfaces, installers and resets, never on the `.`
// barrel, so an app swaps each one way — `apps/<app>/runtime.ts`. Not `src/adapter.ts`: that is
// the `AuthAdapter` seam's.

export {
  installAuthServerStore,
  installedAuthServerStore,
  resetAuthServerStore,
} from './authorization-server-installed';
export type {
  AuthServerStore,
  DeviceDecision,
  RefreshRotation,
} from './authorization-server-store';
export type {
  AuthCodeRecord,
  AuthGrantRecord,
  AuthServerClient,
  AuthTokenKind,
  AuthTokenRecord,
  DeviceCodeRecord,
  DeviceStatus,
} from './authorization-server-types';
export { installKdfGate, resetKdfGate } from './kdf-gate';
export type { AuthLimiterFactory, TotpReplayFactory } from './limiter-install';
export {
  installAuthLimiters,
  installTotpReplay,
  resetAuthLimiters,
  resetTotpReplay,
} from './limiter-install';
export type { TotpReplayGuard } from './mfa';
export type { AuthLimiter, AuthLimiterScope, AuthRateLimitPolicy } from './rate-limit';
