// Hands a module of primitives to the package that owns them, without a sideways import:
// `defineApi` in `@ultimat3/action` cannot import `@ultimat3/query`'s `registerQueries` on
// the same tier, so each owner announces its registrar here at import time and callers ask
// by kind. Same shape as `defineService` and `registerErrorCodes`.

import { UltimateError } from './errors';

/**
 * The eight primitives — the framework's whole vocabulary. A registrar exists only for the
 * kinds registered by module.
 *
 * The runtime list is the source and the type derives from it, so the two cannot drift apart.
 * A ninth entry is a design error, not a feature: a new capability arrives as a FACTORY over an
 * existing primitive — `llm()` returns an `action` — never as a new kind of thing. That rule is
 * only real if something fails when it is broken, so `registrar.test.ts` pins this set.
 */
export const PRIMITIVE_KINDS = [
  'action',
  'entity',
  'job',
  'mutator',
  'policy',
  'query',
  'route',
  'task',
] as const;

export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

/**
 * The package that ANNOUNCES each kind's registrar — a kind is not a package name. Both `fix:`
 * lines below spliced `@ultimat3/${kind}`, so a missing `task` registrar told its reader to
 * `bun add @ultimat3/task`, a package the registry has never had. A `Record` over the union, so a
 * ninth kind fails to compile here before it can ship a fix that 404s.
 */
export const PRIMITIVE_PACKAGES = Object.freeze<Record<PrimitiveKind, string>>({
  action: '@ultimat3/action',
  entity: '@ultimat3/entity',
  job: '@ultimat3/jobs',
  mutator: '@ultimat3/action',
  policy: '@ultimat3/policy',
  query: '@ultimat3/query',
  route: '@ultimat3/render',
  task: '@ultimat3/jobs',
});

/** One factory over one primitive: the export's name, the package that ships it, what it returns. */
export interface PrimitiveFactory {
  readonly factory: string;
  /** The package specifier the factory is imported from, so a `fix:` can be pasted. */
  readonly pkg: string;
  readonly kind: PrimitiveKind;
}

/**
 * The other half of "never invent a ninth": the factories that already exist, in one table.
 *
 * Prose counted them — "the fourth instance of the framework's factory rule" — in three files that
 * cannot see each other, so every ordinal was wrong the moment a fifth landed and none of them
 * could be checked. A list here can be: `@ultimat3/cli` is tier 5, may import `ai`, `jobs` and
 * `scraping`, and pins that every exported function returning an `Action`/`JobHandle` from outside
 * their owning packages has a row. Adding a factory means adding a row, not editing a sentence.
 *
 * Sorted by package then name so the diff of a new row is one line.
 *
 * Every ROW is frozen, not just the list. `readonly` fields are a compile-time claim and this is a
 * public export: freezing the array alone left `PRIMITIVE_FACTORIES[0].kind = 'entity'` a silent
 * write from any untyped caller, which is the same defect `@ultimat3/money`'s currency rows
 * carried — a table the framework hands out is a constant at RUNTIME or it is not a constant.
 */
export const PRIMITIVE_FACTORIES = Object.freeze<readonly PrimitiveFactory[]>(
  (
    [
      // `mutator` and not `action`, even though `Mutator extends Action`: the scan seeds `Mutator`
      // in its own roots and the fixpoint refuses to overwrite a name it already holds, so the
      // more specific answer wins. A `kind: 'action'` here would be the one row the scan disagrees
      // with, and it would disagree silently in the direction that loses information.
      { factory: 'transition', pkg: '@ultimat3/action', kind: 'mutator' },
      { factory: 'agent', pkg: '@ultimat3/ai', kind: 'action' },
      { factory: 'agentJob', pkg: '@ultimat3/ai', kind: 'job' },
      { factory: 'hive', pkg: '@ultimat3/ai', kind: 'action' },
      { factory: 'llm', pkg: '@ultimat3/ai', kind: 'action' },
      { factory: 'backfill', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'consumer', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'exportRows', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'importRows', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'purge', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'refreshView', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'rollup', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'subjectErase', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'subjectExport', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'webhook', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'webhookReceiver', pkg: '@ultimat3/jobs', kind: 'job' },
      { factory: 'mcpConfirmations', pkg: '@ultimat3/mcp', kind: 'action' },
      { factory: 'notifier', pkg: '@ultimat3/notify', kind: 'job' },
      { factory: 'pushRegister', pkg: '@ultimat3/notify', kind: 'action' },
      { factory: 'pushUnregister', pkg: '@ultimat3/notify', kind: 'action' },
      { factory: 'pushSubscribe', pkg: '@ultimat3/pwa', kind: 'action' },
      { factory: 'pushUnsubscribe', pkg: '@ultimat3/pwa', kind: 'action' },
      // A route: the value IS a websocket mount the web role serves (`path`, `fetch`, `websocket`).
      { factory: 'deviceSocket', pkg: '@ultimat3/realtime', kind: 'route' },
      { factory: 'scrape', pkg: '@ultimat3/scraping', kind: 'job' },
    ] satisfies readonly PrimitiveFactory[]
  ).map((entry) => Object.freeze(entry)),
);

/**
 * One swappable backend: the slot an app fills in `apps/<app>/runtime.ts`, the package that owns
 * the interface, the default the boot builds from the environment when that file says nothing, and
 * the `@ultimat3/testing` suite a hand-written adapter proves itself with.
 */
export interface AdapterPort {
  /** The `RuntimeOverrides` field and the key of `@ultimat3/testing`'s per-test override seam. */
  readonly port: string;
  /** The package whose `./adapter` subpath exports `interface` and the errors a driver throws. */
  readonly pkg: `@ultimat3/${string}`;
  /** The type an adapter author implements, exported under this exact name by `pkg`. */
  readonly interface: string;
  /** What the boot builds when `runtime.ts` is silent — the only other selector there is. */
  readonly envDefault: string;
  /** `<interface>Conformance` in `@ultimat3/testing`. Named before it exists: part B enforces it. */
  readonly conformance: `${string}Conformance`;
}

const PG = 'over DATABASE_URL';

/**
 * Every backend an app may swap, one row each (plan 101 slice 21). Extension is adapters, wrapped
 * primitives and event subscriptions — there is no plugin API (axiom 8) — so a backend with no row
 * here is one an app cannot replace without a fork. Six ways to swap a backend (setters, constructor
 * arguments, env switches, a config enum) collapse into one: a field of `runtime.ts`, keyed by
 * `port`. `@ultimat3/cli`'s boot loops over this table; `X_ADAPTER_PORT_INCOMPLETE` (part B) refuses
 * a row missing its slot, its `./adapter` export or its suite, and an exported setter beside it.
 *
 * Sorted by port name. Rows and list frozen, like `PRIMITIVE_FACTORIES`.
 */
const ADAPTER_PORT_ROWS = [
  {
    port: 'aiGateway',
    pkg: '@ultimat3/ai',
    interface: 'Gateway',
    envDefault: 'none: the first model call is refused (X_AI_GATEWAY_MISSING)',
    conformance: 'gatewayConformance',
  },
  {
    port: 'auditSink',
    pkg: '@ultimat3/core',
    interface: 'AuditSink',
    envDefault: 'none: an audit: true primitive is refused (X_AUDIT_SINK_MISSING)',
    conformance: 'auditSinkConformance',
  },
  {
    port: 'authLimiter',
    pkg: '@ultimat3/auth',
    interface: 'AuthLimiterFactory',
    envDefault: `postgresAuthLimiter ${PG}`,
    conformance: 'authLimiterFactoryConformance',
  },
  {
    port: 'authServerStore',
    pkg: '@ultimat3/auth',
    interface: 'AuthServerStore',
    envDefault: `postgresAuthServerStore ${PG}`,
    conformance: 'authServerStoreConformance',
  },
  {
    port: 'cacheTiers',
    pkg: '@ultimat3/cache',
    interface: 'CacheTier',
    envDefault: "the rungs cache.tiers names; 'redis' reads REDIS_URL",
    conformance: 'cacheTierConformance',
  },
  {
    port: 'clock',
    pkg: '@ultimat3/core',
    interface: 'SleepClock',
    envDefault: 'systemClock',
    conformance: 'sleepClockConformance',
  },
  {
    port: 'errorReporter',
    pkg: '@ultimat3/core',
    interface: 'ErrorReporter',
    envDefault: 'SENTRY_DSN set: sentryErrorReporter; unset: the log line only',
    conformance: 'errorReporterConformance',
  },
  {
    port: 'eventBus',
    pkg: '@ultimat3/jobs',
    interface: 'EventBus',
    envDefault: `postgresEventBus ${PG}`,
    conformance: 'eventBusConformance',
  },
  {
    port: 'failureStore',
    pkg: '@ultimat3/core',
    interface: 'FailureStore',
    envDefault: `postgresFailureStore ${PG}, while failureCapture is on`,
    conformance: 'failureStoreConformance',
  },
  {
    port: 'idempotencyStore',
    pkg: '@ultimat3/action',
    interface: 'IdempotencyStore',
    envDefault: `postgresIdempotencyStore ${PG}`,
    conformance: 'idempotencyStoreConformance',
  },
  {
    port: 'images',
    pkg: '@ultimat3/seo',
    interface: 'ImageTransformDriver',
    envDefault: 'builtinImageDriver',
    conformance: 'imageTransformDriverConformance',
  },
  {
    port: 'isrStore',
    pkg: '@ultimat3/render',
    interface: 'IsrStore',
    envDefault: 'a memory store per process',
    conformance: 'isrStoreConformance',
  },
  {
    port: 'jobs',
    pkg: '@ultimat3/jobs',
    interface: 'JobDriver',
    envDefault: `postgresJobDriver ${PG}`,
    conformance: 'jobDriverConformance',
  },
  {
    port: 'mail',
    pkg: '@ultimat3/mail',
    interface: 'MailDriver',
    envDefault:
      'SMTP_URL set: smtp; RESEND_API_KEY set: resend; neither: refused at the first send',
    conformance: 'mailDriverConformance',
  },
  {
    port: 'mcpConfirmationStore',
    pkg: '@ultimat3/mcp',
    interface: 'McpConfirmationStore',
    envDefault: `postgresConfirmationStore ${PG}`,
    conformance: 'mcpConfirmationStoreConformance',
  },
  {
    port: 'meterStore',
    pkg: '@ultimat3/action',
    interface: 'MeterStore',
    envDefault: `postgresMeterStore ${PG}`,
    conformance: 'meterStoreConformance',
  },
  {
    port: 'notifyStores',
    pkg: '@ultimat3/notify',
    interface: 'NotifyStores',
    envDefault: 'a memory delivery ledger, allow-all preferences, no inbox, no digest',
    conformance: 'notifyStoresConformance',
  },
  {
    port: 'outboxStore',
    pkg: '@ultimat3/jobs',
    interface: 'OutboxStore',
    envDefault: `postgresOutboxStore ${PG}`,
    conformance: 'outboxStoreConformance',
  },
  {
    port: 'purge',
    pkg: '@ultimat3/cache',
    interface: 'PurgeDriver',
    envDefault:
      'CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID: cloudflare; FASTLY_API_TOKEN + FASTLY_SERVICE_ID: fastly; neither: none',
    conformance: 'purgeDriverConformance',
  },
  {
    port: 'pushSubscriptionStore',
    pkg: '@ultimat3/pwa',
    interface: 'PushSubscriptionStore',
    envDefault: `postgresPushSubscriptionStore ${PG}, while VAPID keys are set`,
    conformance: 'pushSubscriptionStoreConformance',
  },
  {
    port: 'rateLimitStore',
    pkg: '@ultimat3/http',
    interface: 'RateLimitStore',
    envDefault: `postgresRateLimitStore ${PG}`,
    conformance: 'rateLimitStoreConformance',
  },
  {
    port: 'scrapeDriver',
    pkg: '@ultimat3/scraping',
    interface: 'ScrapeDriver',
    envDefault: 'none: a scrape() declaring no driver is refused at its first run',
    conformance: 'scrapeDriverConformance',
  },
  {
    port: 'secretSource',
    pkg: '@ultimat3/core',
    interface: 'SecretSource',
    envDefault: 'ULTIMATE_SECRETS_KEY, then the .secrets.key file',
    conformance: 'secretSourceConformance',
  },
  {
    port: 'storage',
    pkg: '@ultimat3/storage',
    interface: 'StorageDriver',
    envDefault: 'S3_ENDPOINT set: s3; unset: the embedded disk',
    conformance: 'storageDriverConformance',
  },
  {
    port: 'totpReplay',
    pkg: '@ultimat3/auth',
    interface: 'TotpReplayGuard',
    envDefault: `postgresTotpReplayGuard ${PG}`,
    conformance: 'totpReplayGuardConformance',
  },
  {
    port: 'transport',
    pkg: '@ultimat3/realtime',
    interface: 'Transport',
    envDefault: 'NATS_URL set: nats; unset: memory (one node)',
    conformance: 'transportConformance',
  },
] as const satisfies readonly AdapterPort[];

/** One port's name — `Record<AdapterPortName, …>` is how a consumer is made to cover every row. */
export type AdapterPortName = (typeof ADAPTER_PORT_ROWS)[number]['port'];

export const ADAPTER_PORTS = Object.freeze<readonly AdapterPort[]>(
  ADAPTER_PORT_ROWS.map((row) => Object.freeze({ ...row })),
);

export const ADAPTER_PORT_NAMES: readonly AdapterPortName[] = Object.freeze(
  ADAPTER_PORT_ROWS.map((row) => row.port),
);

/**
 * What a registrar hands back: the primitives it actually took, each carrying the name
 * registration stamped on it. Returning the registered set — rather than nothing — is what lets
 * a caller build its API map from what registered instead of from what a module exported.
 */
export interface RegisteredPrimitive {
  readonly kind: PrimitiveKind;
  readonly name: string;
}

/** `registerActions` / `registerQueries`: export names become primitive names. */
export type ModuleRegistrar = (
  module: Readonly<Record<string, unknown>>,
) => readonly RegisteredPrimitive[];

const registrars = new Map<PrimitiveKind, ModuleRegistrar>();

/**
 * Announce the registrar for `kind`, once per process. Re-announcing the same function is a
 * no-op (a module re-evaluated under a different specifier); announcing a *different* one
 * means two copies of the owning package are loaded, each with its own registry — half the
 * primitives would register into a table nothing else reads.
 */
export function registerPrimitiveRegistrar(kind: PrimitiveKind, registrar: ModuleRegistrar): void {
  const existing = registrars.get(kind);
  if (existing !== undefined && existing !== registrar) {
    throw new UltimateError({
      code: 'X_REGISTRAR_CONFLICT',
      cause: `two different ${kind} registrars are loaded, so ${kind} primitives would split across two registries`,
      // One command, because a `fix:` is pasted verbatim: collapsing every range on the package
      // to one resolved version is the repair. `bun pm why <package>` names the dependents when
      // a range genuinely disagrees and the update cannot converge on its own.
      fix: `bun update ${PRIMITIVE_PACKAGES[kind]}`,
      meta: { kind },
    });
  }
  registrars.set(kind, registrar);
}

export function hasPrimitiveRegistrar(kind: PrimitiveKind): boolean {
  return registrars.has(kind);
}

/**
 * The registrar for `kind`. Throws rather than returning `undefined`: a caller that skipped a
 * missing registrar would drop every primitive of that kind silently, which is exactly the
 * failure this seam exists to make impossible.
 */
export function primitiveRegistrar(kind: PrimitiveKind): ModuleRegistrar {
  const registrar = registrars.get(kind);
  if (registrar === undefined) {
    throw new UltimateError({
      code: 'X_REGISTRAR_MISSING',
      cause: `no ${kind} registrar is loaded, so ${kind} primitives cannot be registered`,
      fix: `bun add ${PRIMITIVE_PACKAGES[kind]}`,
      meta: { kind },
    });
  }
  return registrar;
}

/** Test-only. Production announces once at import and never withdraws. */
export function resetPrimitiveRegistrars(): void {
  registrars.clear();
}
