// The `realtime` section for the boot, out of the config `startServices` loads once
// (`app-config-load.ts`). Until 22.0.0 no boot read `enabled`, `transport` or `urlEnv` and
// `NATS_URL` alone decided the bus; the two per-actor caps are read by the `sync` role.

import type { AppConfig, RealtimeConfig } from '@ultimat3/core';

/** Core's `defaults()` for the section — the answer for a root with no `app.config.ts`. */
export const REALTIME_DEFAULTS: RealtimeConfig = Object.freeze({
  enabled: true,
  transport: 'memory',
  urlEnv: undefined,
  maxSubscriptionsPerActor: undefined,
  maxSocketsPerActor: undefined,
});

/**
 * The section as the boot obeys it — `defineConfig`'s per-key merge, so the boot and the app's own
 * config object agree, and a transport nothing builds is core's `X_CONFIG_INVALID`.
 */
export const realtimeConfigOf = (config: AppConfig | undefined): RealtimeConfig =>
  config?.realtime ?? REALTIME_DEFAULTS;
