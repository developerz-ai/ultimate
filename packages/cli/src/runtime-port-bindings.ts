// Where this boot honours each `ADAPTER_PORTS` row: its installer and its undo, the module that
// reads it as a value, or — for a row whose package exposes no installer yet — the owner that must
// ship one. Typed `PortBindings`, so a row core adds is a build error HERE until it is bound.

import { installAuthLimiters, installTotpReplay } from '@ultimat3/auth/adapter';
import { getAuditSink, resetAuditSink, setAuditSink } from '@ultimat3/core';
import { installRateLimitStore } from '@ultimat3/http/adapter';
import { installMailDriver } from '@ultimat3/mail/adapter';
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
  auditSink: {
    phase: 'services',
    // Restores the sink it found, never the empty default: core's slot has no release of its own
    // (a shared `adapterSlot` helper replaces this when core lands it).
    install: (sink) => {
      const found = getAuditSink();
      setAuditSink(sink);
      return () => (found === null ? resetAuditSink() : setAuditSink(found));
    },
  },
  authLimiter: {
    phase: 'services',
    install: (factory) => installAuthLimiters(factory),
  },
  authServerStore: {
    phase: 'pending',
    owner:
      '@ultimat3/auth: authorizationServer({ store }) requires the store; needs an installed default',
  },
  cacheTiers: {
    phase: 'pending',
    owner: '@ultimat3/cli: cache.tiers names the rungs and runtime-cache.ts builds them from names',
  },
  clock: BOOT_PORT_BINDINGS.clock,
  errorReporter: {
    phase: 'pending',
    owner: '@ultimat3/core + serve-env.ts: the SENTRY_DSN transport composes with an app reporter',
  },
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
    phase: 'pending',
    owner:
      '@ultimat3/mcp: mcpConfirmations({ store }) requires the store; needs an installed default',
  },
  meterStore: QUEUE_PORT_BINDINGS.meterStore,
  notifyStores: {
    phase: 'services',
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
  storage: { phase: 'read', at: 'runtime-storage-boot.ts, the disks' },
  totpReplay: {
    phase: 'services',
    install: (guard) => installTotpReplay(() => guard),
  },
  transport: { phase: 'read', at: 'runtime-bus.ts, which installs the channel transport it dials' },
};
