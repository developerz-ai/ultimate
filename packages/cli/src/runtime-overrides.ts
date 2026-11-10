// The one place a host hands the framework a driver. `ServeOptions` had `{ root, env, role, port,
// metricsPort }` and nothing else, so the ONLY way to install a driver was to call an ambient
// setter from an app module — which `loadApp` imports *after* `startServices` has already captured
// its own. This type is the seam that removes the need to, and every field is read exactly once,
// as the first arm of `overrides?.x ?? <the env-selected default>`.

import type { IdempotencyStore, MeterStore } from '@ultimat3/action/adapter';
import type { Gateway } from '@ultimat3/ai/adapter';
import type { AuthLimiterFactory, AuthServerStore, TotpReplayGuard } from '@ultimat3/auth/adapter';
import type { CacheTier, PurgeDriver } from '@ultimat3/cache/adapter';
import type {
  AuditSink,
  ErrorReporter,
  FailureStore,
  SecretSource,
  SleepClock,
} from '@ultimat3/core/adapter';
import type { Middleware, Route } from '@ultimat3/http';
import type { RateLimitStore } from '@ultimat3/http/adapter';
import type { OutboxStore } from '@ultimat3/jobs';
import type { EventBus, JobDriver } from '@ultimat3/jobs/adapter';
import type { MailDriver } from '@ultimat3/mail/adapter';
import type { McpConfirmationStore } from '@ultimat3/mcp/adapter';
import type { NotifyStores } from '@ultimat3/notify/adapter';
import type { PushSubscriptionStore } from '@ultimat3/pwa/adapter';
import type { Transport } from '@ultimat3/realtime/adapter';
import type { IsrStore } from '@ultimat3/render/adapter';
import type { ScrapeDriver } from '@ultimat3/scraping/adapter';
import type { ImageTransformDriver } from '@ultimat3/seo/adapter';
import type { StorageDriver } from '@ultimat3/storage/adapter';

/**
 * One field per `ADAPTER_PORTS` row this boot honours, named by the row's `port`. Every field is
 * read exactly once, as the first arm of `runtime.x ?? <the env default>`; `runtime-ports.ts`
 * binds each to its installer or reader, and a row with no field here is listed there as pending.
 */
export interface PortValues {
  /** The model gateway every `llm()`/`agent()` call goes through. No default: refused at first call. */
  readonly aiGateway: Gateway;
  /** Where `audit: true` primitives write. No default: an audited primitive is refused without one. */
  readonly auditSink: AuditSink;
  /**
   * Where failed sign-ins are counted — a FACTORY, one limiter per policy, because `defineAuth`
   * declares `maxAttempts`/`windowMs`/`lockoutMs` after this boot. Default `postgresAuthLimiter`.
   */
  readonly authLimiter: AuthLimiterFactory;
  /**
   * Where `authorizationServer()` keeps clients, codes, grants and tokens when it names no `store`.
   * Default `postgresAuthServerStore` over the app's pool.
   */
  readonly authServerStore: AuthServerStore;
  /**
   * Rung implementations. `cache.tiers` still NAMES the ladder: a tier here replaces the rung of
   * its own `name` (a `redis` tier needs no `REDIS_URL`), the boot builds every other named rung,
   * and a tier whose name `cache.tiers` does not list is logged (`cache.tier.unnamed`) and unused.
   */
  readonly cacheTiers: readonly CacheTier[];
  /** The process's clock: every "now" and every wait not handed one. Default `systemClock`. */
  readonly clock: SleepClock;
  /**
   * Where every caught error is reported. `SENTRY_DSN` still adds the boot's transport BESIDE it
   * when this is a local sink (`localErrorSink`), and none when it is the app's own Sentry
   * transport (`sentryTransport`). Default: no reporter but the log line.
   */
  readonly errorReporter: ErrorReporter;
  /** The durable bus `step.waitForEvent` resumes from. Default `postgresEventBus`. */
  readonly eventBus: EventBus;
  /** Where `failureCapture` keeps a 5xx's bundle, while it is on. Default `postgresFailureStore`. */
  readonly failureStore: FailureStore;
  /**
   * Where `idempotent: true` reservations live. Default `postgresIdempotencyStore`; one whose scope
   * is `'process'` is legal and warned about — a retry on another replica runs twice.
   */
  readonly idempotencyStore: IdempotencyStore;
  /** The `/media/*` transform. Omitted, `builtinImageDriver` — core's PNG/JPEG/WebP pipeline. */
  readonly images: ImageTransformDriver;
  /**
   * Where regenerated ISR pages live. Omitted, `isrController` keeps a per-process memory
   * store — twelve replicas then hold twelve of them, and a purge tag reaches one twelfth of the
   * fleet.
   */
  readonly isrStore: IsrStore;
  /**
   * The queue every enqueue AND every claim uses. Installed as the ambient driver too, so
   * `jobDriver()` and the worker cannot disagree — `startRoles` refuses to boot when they do.
   */
  readonly jobs: JobDriver;
  /** Replaces the `SMTP_URL` / `RESEND_API_KEY` selection. */
  readonly mail: MailDriver;
  /**
   * Where `mcpConfirmations()` keeps pending rows when it names no `store`. Default
   * `postgresConfirmationStore` over the app's pool.
   */
  readonly mcpConfirmationStore: McpConfirmationStore;
  /** `meter:` counters. Default `postgresMeterStore`, one row per tenant-day on every replica. */
  readonly meterStore: MeterStore;
  /**
   * A notifier's ledger, preferences, inbox and digest. A missing `ledger` is the boot's
   * `postgresDeliveryLedger` over its pool (`runtime-port-bindings.ts`); the rest default in notify.
   */
  readonly notifyStores: NotifyStores;
  /** The `x_outbox` store behind `handle.enqueue()`. Default `postgresOutboxStore`. */
  readonly outboxStore: OutboxStore;
  /** Replaces the `CLOUDFLARE_*` / `FASTLY_*` selection behind the `cdn` cache tier. */
  readonly purge: PurgeDriver;
  /** Where Web Push subscriptions live, while `pwa.vapid` is set. Default the Postgres store. */
  readonly pushSubscriptionStore: PushSubscriptionStore;
  /**
   * Where the HTTP rate limiter keeps its counters. It also DECIDES `rateLimit.scope`: a store
   * that says `'shared'` is a deployment declaring fleet-wide numbers, and `assertRateLimitScope`
   * holds the two halves together rather than a literal in the boot contradicting the store.
   *
   * Omitted, the boot installs `postgresRateLimitStore` over the pool it already opened
   * (`startServices`) — so this replaces a SHARED default, not an absent one. A store whose scope
   * is `'process'` is legal and warned about: it is every declared limit enforced once per
   * replica, and `docker/helm/values.yaml` runs three.
   */
  readonly rateLimitStore: RateLimitStore;
  /** The browser a `scrape()` declaring no driver of its own runs on. No default: refused at run. */
  readonly scrapeDriver: ScrapeDriver;
  /**
   * Where the secrets master key comes from. Installed before `app.config.ts` evaluates, so its
   * `installSecrets()` asks this. Default `ULTIMATE_SECRETS_KEY`, then `.secrets.key`.
   */
  readonly secretSource: SecretSource;
  /**
   * The boot's default disk, registered under the driver's own `name`: replaces the
   * `S3_ENDPOINT`/embedded-disk decision. Several disks are the app's `defineStorage()`, which wins.
   */
  readonly storage: StorageDriver;
  /** Where spent TOTP steps are kept, fleet-wide. Default `postgresTotpReplayGuard`. */
  readonly totpReplay: TotpReplayGuard;
  /**
   * Replaces the `NATS_URL` selection — any `Transport`. Already connected when it arrives, and
   * NOT closed by `stop()`: whoever built it owns its socket.
   */
  readonly transport: Transport;
}

/**
 * What a deployment may substitute for a boot decision the environment would otherwise make —
 * the `runtime` export of `apps/<app>/runtime.ts`, the ONE place an app swaps a backend.
 *
 * Every field is OPTIONAL and every field REPLACES the default rather than sitting beside it: the
 * env switch each one used to be is now the `??` arm of one expression, so there is exactly one
 * answer to "which driver is this process running" (axiom 1). A field nothing consumes is not
 * here — the entity `Driver` in particular, because `@ultimat3/entity` exposes no installer for
 * one (`database(entities, { driver })` is the app's own call), and a slot the boot cannot honour
 * is the class of defect this seam exists to end.
 */
export interface RuntimeOverrides extends Partial<PortValues> {
  /** Prepended to the pipeline by `httpServer`, which `startRoles` never passed one. */
  readonly middleware?: readonly Middleware[];
  /**
   * Plain HTTP routes at paths no primitive projects to — `/.well-known/oauth-authorization-server`,
   * a form-encoded `POST /oauth/token` answering RFC 6749 JSON, a feed with its own content type.
   * Mounted by both boots, after the framework's own and before the pages, through the same
   * pipeline (`meta.auth` required, CSRF, limits, security headers). The one escape hatch for a
   * wire format a primitive cannot speak: an action answers JSON or a problem document, a page
   * answers a document, and a protocol that fixes its own error shape is neither.
   */
  readonly routes?: readonly Route[];
}
