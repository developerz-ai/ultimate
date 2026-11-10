// Where this boot honours each `ADAPTER_PORTS` row: its installer and its undo, or the module that
// reads it as a value. Typed `PortBindings`, so a row core adds is a build error HERE until it is
// bound.

import {
  installAuthLimiters,
  installAuthServerStore,
  installTotpReplay,
} from '@ultimat3/auth/adapter';
import type { PgExecutor } from '@ultimat3/core';
import { installAuditSink, installErrorReporter } from '@ultimat3/core/adapter';
import { installRateLimitStore } from '@ultimat3/http/adapter';
import { installMailDriver } from '@ultimat3/mail/adapter';
import { postgresDeliveryLedger } from '@ultimat3/notify';
import type { NotifyStores } from '@ultimat3/notify/adapter';
import { installNotifyStores } from '@ultimat3/notify/adapter';
import { BOOT_PORT_BINDINGS, QUEUE_PORT_BINDINGS } from './runtime-port-bindings-queue';
import type { PortBindings } from './runtime-ports';

/** Every row, bound. Pure data plus closures: installing happens only in `installPorts`. */
export const PORT_BINDINGS: PortBindings = {
  aiGateway: {
    phase: 'services',
    // Imported only when supplied: most apps run no model, and no role should load `@ultimat3/ai`.
    install: async (gateway) => (await import('@ultimat3/ai/adapter')).installAiGateway(gateway),
  },
  auditSink: { phase: 'services', install: (sink) => installAuditSink(sink) },
  authLimiter: {
    phase: 'services',
    install: (factory) => installAuthLimiters(factory),
  },
  // Installed only when supplied: unset, auth's own slot answers its env default — Postgres over
  // the ambient pool, the pool this boot installed (`runtime-queue.ts`'s `setDbClient`).
  authServerStore: { phase: 'services', install: (store) => installAuthServerStore(store) },
  cacheTiers: { phase: 'read', at: 'runtime-cache.ts, each replacing the rung of its own name' },
  clock: BOOT_PORT_BINDINGS.clock,
  // Before `loadApp`; `serve-env.ts`'s `configureReporting` later chains its `SENTRY_DSN`
  // transport in a frame above it, so this counts as the app's reporter there.
  errorReporter: { phase: 'services', install: (reporter) => installErrorReporter(reporter) },
  eventBus: QUEUE_PORT_BINDINGS.eventBus,
  failureStore: { phase: 'read', at: 'failure-capture-boot.ts, while failureCapture is on' },
  idempotencyStore: QUEUE_PORT_BINDINGS.idempotencyStore,
  images: { phase: 'read', at: 'serve-web.ts, the /media/* transform' },
  isrStore: { phase: 'read', at: 'serve-web.ts, the ISR controller' },
  jobs: QUEUE_PORT_BINDINGS.jobs,
  mail: {
    phase: 'services',
    install: (driver) => installMailDriver(driver),
  },
  mcpConfirmationStore: {
    phase: 'services',
    // Imported only when supplied, for `aiGateway`'s reason: most roles load no MCP module, and
    // unset, mcp's own slot answers its env default (Postgres over the ambient pool).
    install: async (store) =>
      (await import('@ultimat3/mcp/adapter')).installConfirmationStore(store),
  },
  meterStore: QUEUE_PORT_BINDINGS.meterStore,
  notifyStores: {
    phase: 'services',
    // Always a value: `startServices` fills a missing ledger with Postgres over its pool.
    install: (stores) => installNotifyStores(stores),
  },
  outboxStore: { phase: 'read', at: 'runtime-queue.ts, behind the jobs facade with the jobs port' },
  purge: { phase: 'read', at: 'runtime-cache.ts, the cdn tier' },
  pushSubscriptionStore: { phase: 'read', at: 'runtime-push.ts, while pwa.vapid is set' },
  rateLimitStore: {
    phase: 'services',
    install: (store) => installRateLimitStore(store),
  },
  scrapeDriver: {
    phase: 'services',
    // Imported only when supplied, for `aiGateway`'s reason: a browser driver is a scraping app's.
    install: async (driver) =>
      (await import('@ultimat3/scraping/adapter')).installScrapeDriver(driver),
  },
  secretSource: BOOT_PORT_BINDINGS.secretSource,
  storage: { phase: 'read', at: 'runtime-storage-boot.ts, the default disk' },
  totpReplay: {
    phase: 'services',
    install: (guard) => installTotpReplay(() => guard),
  },
  transport: { phase: 'read', at: 'runtime-bus.ts, which installs the channel transport it dials' },
};

/**
 * The `notifyStores` value with zero config: a booted app has a database, so a MISSING ledger is
 * Postgres over the boot's pool — an app's own ledger, inbox, preferences and digest are never
 * replaced. `x_notify_deliveries` is applied every boot (`framework-schema.ts`) and swept hourly
 * (`runtime-purge.ts`). Notify's own default (memory in development/test, `X_NOTIFY_STORE_MISSING`
 * elsewhere) stays the net for a process no boot installed into. Here, beside the binding, so the
 * serving graph pays no module for it.
 */
export function notifyStoresWithLedger(
  supplied: NotifyStores | undefined,
  executor: PgExecutor,
): NotifyStores {
  if (supplied?.ledger !== undefined) return supplied;
  return { ...supplied, ledger: postgresDeliveryLedger({ executor }) };
}
