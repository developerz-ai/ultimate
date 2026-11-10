// The `realtime` section for the boot, out of the config `startServices` loads once
// (`app-config-load.ts`). `enabled` decides the realtime roles; the two per-actor caps are read by
// the `sync` role, `maxQueued` by `page-sync.ts` (the page outbox's ceiling, on every document).
// The bus is not here: `NATS_URL`, or `transport` in `apps/<app>/runtime.ts` (v31).

import type { AppConfig, RealtimeConfig } from '@ultimat3/core';

/** Core's `defaults()` for the section — the answer for a root with no `app.config.ts`. */
export const REALTIME_DEFAULTS: RealtimeConfig = Object.freeze({
  enabled: true,
  maxSubscriptionsPerActor: undefined,
  maxSocketsPerActor: undefined,
  maxQueued: undefined,
});

/**
 * The section as the boot obeys it — `defineConfig`'s per-key merge, so the boot and the app's own
 * config object agree.
 */
export const realtimeConfigOf = (config: AppConfig | undefined): RealtimeConfig =>
  config?.realtime ?? REALTIME_DEFAULTS;
