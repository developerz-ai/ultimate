// Single responsibility: `swapAdapter(port, impl)` — the one way a test replaces an adapter port
// (`ADAPTER_PORTS`, core's registrar) for itself: installed through the port's own `./adapter`
// installer, put back after the test (`test-scope.ts`). Every port is either bound here or listed in
// `UNSWAPPED` with what a test does instead — a new row in core's table is a compile error here.

import type { IdempotencyStore, MeterStore } from '@ultimat3/action/adapter';
import type { Gateway } from '@ultimat3/ai/adapter';
import type { AuthLimiterFactory, TotpReplayGuard } from '@ultimat3/auth/adapter';
import type { AdapterPortName, ErrorReporter } from '@ultimat3/core';
import type { AuditSink, FailureStore, SecretSource, SleepClock } from '@ultimat3/core/adapter';
import type { RateLimitStore } from '@ultimat3/http/adapter';
import type { EventBus, JobDriver } from '@ultimat3/jobs/adapter';
import type { MailDriver } from '@ultimat3/mail/adapter';
import type { NotifyStores } from '@ultimat3/notify/adapter';
import type { Transport } from '@ultimat3/realtime/adapter';
import type { ScrapeDriver } from '@ultimat3/scraping/adapter';
import { TestAdapterPortUnswappableError } from './stub-errors';
import type { Undo } from './test-scope';
import { scopedInstall } from './test-scope';

/** What each process-global port takes. The key is the `ADAPTER_PORTS` row's `port`. */
export interface SwappableAdapters {
  readonly aiGateway: Gateway;
  readonly auditSink: AuditSink;
  readonly authLimiter: AuthLimiterFactory;
  readonly clock: SleepClock;
  readonly errorReporter: ErrorReporter;
  readonly eventBus: EventBus;
  readonly failureStore: FailureStore;
  readonly idempotencyStore: IdempotencyStore;
  readonly jobs: JobDriver;
  readonly mail: MailDriver;
  readonly meterStore: MeterStore;
  readonly notifyStores: NotifyStores;
  readonly rateLimitStore: RateLimitStore;
  readonly scrapeDriver: ScrapeDriver;
  readonly secretSource: SecretSource;
  readonly totpReplay: TotpReplayGuard;
  readonly transport: Transport;
}

/** The ports `swapAdapter` takes. Every one is a row of `ADAPTER_PORTS`, or this fails to compile. */
export type SwappablePort = keyof SwappableAdapters & AdapterPortName;

type Bindings = { readonly [P in SwappablePort]: (impl: SwappableAdapters[P]) => Promise<Undo> };

// Every installer answers its own release, restoring the value it replaced. `auditSink` and
// `errorReporter` are core's two that do not yet (reported), so they put back what they found here.
const BINDINGS: Bindings = {
  aiGateway: async (impl) => (await import('@ultimat3/ai/adapter')).installAiGateway(impl),
  auditSink: async (impl) => {
    const core = await import('@ultimat3/core');
    const found = core.getAuditSink();
    core.setAuditSink(impl);
    return () => (found === null ? core.resetAuditSink() : core.setAuditSink(found));
  },
  authLimiter: async (impl) => (await import('@ultimat3/auth/adapter')).installAuthLimiters(impl),
  clock: async (impl) => (await import('@ultimat3/core/adapter')).installClock(impl),
  errorReporter: async (impl) => {
    const core = await import('@ultimat3/core');
    const found = core.installedErrorReporter();
    core.configureErrorReporting({ reporter: impl });
    return () => core.configureErrorReporting({ reporter: found });
  },
  eventBus: async (impl) => (await import('@ultimat3/jobs/adapter')).installEventBus(impl),
  failureStore: async (impl) => (await import('@ultimat3/core/adapter')).installFailureStore(impl),
  idempotencyStore: async (impl) =>
    (await import('@ultimat3/action/adapter')).installIdempotencyStore(impl),
  jobs: async (impl) => (await import('@ultimat3/jobs/adapter')).installJobDriver(impl),
  mail: async (impl) => (await import('@ultimat3/mail/adapter')).installMailDriver(impl),
  meterStore: async (impl) => (await import('@ultimat3/action/adapter')).installMeterStore(impl),
  notifyStores: async (impl) =>
    (await import('@ultimat3/notify/adapter')).installNotifyStores(impl),
  rateLimitStore: async (impl) =>
    (await import('@ultimat3/http/adapter')).installRateLimitStore(impl),
  scrapeDriver: async (impl) =>
    (await import('@ultimat3/scraping/adapter')).installScrapeDriver(impl),
  secretSource: async (impl) => (await import('@ultimat3/core/adapter')).installSecretSource(impl),
  // The slot takes a factory; the port carries one guard, which every call hands back.
  totpReplay: async (impl) =>
    (await import('@ultimat3/auth/adapter')).installTotpReplay(() => impl),
  transport: async (impl) =>
    (await import('@ultimat3/realtime/adapter')).installChannelTransport(impl),
};

/**
 * The ports with no process-global slot a test could borrow, each with what a test does instead.
 * A `Record` over the rest of `AdapterPortName`: a port added to core's table is a compile error
 * until it is bound above or given its instruction here.
 */
export const UNSWAPPED: Readonly<Record<Exclude<AdapterPortName, SwappablePort>, string>> = {
  authServerStore:
    'passed to the authorization server when the app builds it: build one over a memory store in the test',
  cacheTiers:
    "registered by the boot from cache.tiers: register the test's tier with @ultimat3/cache's isolateTiers()",
  images:
    'handed to the image route when the boot mounts it: call the route with your driver in the test',
  isrStore: 'handed to the renderer at boot: pass your store to the render call under test',
  mcpConfirmationStore:
    'handed to the MCP server when the boot builds it: build the server with your store in the test',
  outboxStore: "the boot's outbox relay takes it: build the relay with your store in the test",
  purge: "handed to the cache's CDN purge at boot: pass your driver to the bust under test",
  pushSubscriptionStore: 'the push fixture owns one: destructure { push } in the test',
  storage: 'disks are built by the boot: build the disk over your driver in the test',
};

const isSwappable = (port: string): port is SwappablePort => Object.hasOwn(BINDINGS, port);

/**
 * Replace a port's adapter for this test — inside a test, until it ends; outside one, until the
 * file ends — and hand back `impl`, so the swap and the reference are one line:
 *
 * ```ts
 * const queue = await swapAdapter('jobs', memoryJobDriver());
 * ```
 */
export async function swapAdapter<P extends SwappablePort>(
  port: P,
  impl: SwappableAdapters[P],
): Promise<SwappableAdapters[P]> {
  if (!isSwappable(port)) throw new TestAdapterPortUnswappableError(port, UNSWAPPED);
  const install = BINDINGS[port] as (next: SwappableAdapters[P]) => Promise<Undo>;
  return scopedInstall(`swapAdapter('${port}')`, async () => ({
    value: impl,
    undo: await install(impl),
  }));
}
