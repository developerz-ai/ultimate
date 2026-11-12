// The guard's three declared tables, each row with its reason: the RATCHET of port parts not built
// yet (each row may only be deleted), the barrel installers that select no backend, and the
// port-shaped `./adapter` types that are a member of a row rather than a row. A row that excuses
// nothing is itself `X_ADAPTER_PORT_INCOMPLETE`, so every table only shrinks to the truth.
//
// why: these tables are new with the guard (plan 101 slice 21); each row's VALUE is its reason, and
// every BARREL_INSTALLERS row is a name a barrel exports today — one that selects no backend, or a
// move still scheduled (`pending —`). PENDING_PARTS is empty: every port ships whole.

/** The five parts every port owes (plan 101 slice 21): one key per part, in this order. */
export const PORT_PARTS = ['field', 'binding', 'adapter', 'conformance', 'docs'] as const;
export type PortPart = (typeof PORT_PARTS)[number];

/**
 * `<port>#<part>` → why it is not built yet. Deleting a row is the only edit: the guard reds a row
 * whose part now exists, naming it. Never add one to land a NEW port — a new row ships whole.
 */
export const PENDING_PARTS = Object.freeze<Record<string, string>>({});

/**
 * `<pkg>#<name>` → why a `set*`/`configure*`/`install*` on a `.` barrel selects no backend (it is
 * configuration, a per-request helper or process wiring), or — prefixed `pending —` — which agent
 * is moving it. `@ultimat3/testing` is not scanned: its barrel is the test seams.
 */
export const BARREL_INSTALLERS = Object.freeze<Record<string, string>>({
  '@ultimat3/action#configureIdempotency':
    'why: declares the scope and ceiling the store is checked against; the store is the idempotencyStore port',
  '@ultimat3/action#configureActionPathStyle': 'why: the app pathStyle, configuration',
  '@ultimat3/ai#configureAi':
    'why: the redactor only, configuration; the gateway, embedder and semantic cache are the aiGateway, embedder and semanticCache ports',
  '@ultimat3/core#configureErrorReporting':
    'why: clock, release, environment and enabled only (reporter?: never): the reporter is the errorReporter port',
  // why: replaces the `setLogSink` row (wave F's rename landed): installLogSink is a test seam on
  // core's barrel that routes the process logger's lines, not a backend port — the row is new, not a raise.
  '@ultimat3/core#installLogSink':
    "why: the test seam deciding WHERE the process logger's lines go instead of the streams, released by its own call; never a backend — the tee is log.record on the bus",
  '@ultimat3/core#configureCursorSigning': 'why: installs a secret, not a backend',
  '@ultimat3/core#configureMetrics':
    "why: clock and enabled only, configuration; an exporter is a subscribe('metric.export', …) on the instrumentation bus, as spans and logs are",
  '@ultimat3/core#configureTelemetry': 'why: service name, sampler and clock: configuration',
  '@ultimat3/core#setLoggerContextFields':
    'why: internal wiring, context.ts hands the logger its field provider',
  '@ultimat3/core#setLogStream': 'why: stdout or stderr for the process logger, chosen at entry',
  '@ultimat3/core#installSecrets':
    'why: loads secrets.enc.json into the environment; the key comes from the secretSource port',
  '@ultimat3/core#configureLifecycle': 'why: drain deadlines, configuration',
  '@ultimat3/core#installSignalHandlers': 'why: process signal wiring, no backend',
  '@ultimat3/db#setDbClient':
    'why: the entity driver is deliberately not a port: database(entities, { driver }) is the app call',
  '@ultimat3/db#setLocal': 'why: SET LOCAL on one transaction, a per-call helper',
  '@ultimat3/db#setTransactionSettings': 'why: the row-security settings provider for each BEGIN',
  '@ultimat3/flags#configureFlags': 'why: the overdue-report interval, configuration',
  '@ultimat3/http#configureHttp': 'why: the app half of HttpConfig, configuration',
  '@ultimat3/http#configureAuthenticator':
    'why: the app authenticator, a function of the app, not a swappable backend',
  '@ultimat3/http#setRedirect': 'why: answers the request in scope, a per-request helper',
  '@ultimat3/http#setCookie': 'why: answers the request in scope, a per-request helper',
  '@ultimat3/i18n#configureLocales': 'why: supported locales and the default, configuration',
  '@ultimat3/jobs#setJobsFacade':
    'why: boot wiring of the enqueue facade over the jobs and outboxStore ports, not a port itself',
  '@ultimat3/mail#setMailTransform': 'why: a per-message rewrite hook, not a delivery backend',
  '@ultimat3/pwa#installController': 'why: the browser install prompt, client-side UI',
  '@ultimat3/pwa#installWebPush':
    'why: the VAPID runtime the boot resolves from env; the store it writes is the pushSubscriptionStore port',
  '@ultimat3/realtime#installRealtime': 'why: the island bootstrap a build prepends, client-side',
  '@ultimat3/render#setAssetResolver': 'why: the build manifest lookup loadApp installs',
  '@ultimat3/schema#configureSchemaProvider': 'why: the schema vendor, a declaration-time choice',
  '@ultimat3/seo#setStaticExport': 'why: the static build marks itself, process wiring',
  '@ultimat3/time#configureTime': 'why: the default zone, configuration',
  '@ultimat3/ui#setSolidRuntime': 'why: the solid-js functions an island bundle registers',
  '@ultimat3/ui#setTheme': 'why: the visitor theme in the browser',
});

/** The packages whose `.` barrel is not scanned, each with why. */
export const BARREL_UNSCANNED = Object.freeze<Record<string, string>>({
  '@ultimat3/testing': 'why: its barrel IS the test seams (setFrozenClock, installE2eDriver, …)',
});

/**
 * `<pkg>#<type>` → the row it belongs to: a port-shaped type on a `./adapter` subpath that is a
 * MEMBER of a row (what a factory returns, a sub-store, the read half), never a port of its own.
 */
export const PORT_MEMBERS = Object.freeze<Record<string, string>>({
  // why: batchedAuditSink (sweep 8) — the writeMany sink it wraps is a member, not a new port
  '@ultimat3/action#BatchAuditSink':
    'why: auditSink: an AuditSink with writeMany, what batchedAuditSink wraps',
  // why: batchedAuditSink (sweep 8) returns this, and it is installed as the auditSink port
  '@ultimat3/action#BatchedAuditSink':
    'why: auditSink: what batchedAuditSink returns, handed over as the auditSink',
  '@ultimat3/ai#BudgetLedger':
    'why: aiGateway: a class a Gateway hands out per call, not implemented by an adapter',
  '@ultimat3/auth#AuthLimiter':
    'why: authLimiter: what an AuthLimiterFactory returns, one per policy',
  '@ultimat3/auth#TotpReplayFactory':
    'why: totpReplay: the installer argument that builds a TotpReplayGuard',
  '@ultimat3/core#Clock': 'why: clock: the read half every SleepClock is',
  '@ultimat3/core#FrozenClock': 'why: clock: a SleepClock a test installs through the clock port',
  '@ultimat3/jobs#LeaseStore':
    'why: jobs: JobDriver.leases, the fleet slots a driver ships in its own DDL',
  '@ultimat3/jobs#StepStore':
    'why: jobs: JobDriver.steps, the durable step results a driver ships in its own DDL',
  '@ultimat3/notify#DeliveryLedger': 'why: notifyStores: one member of NotifyStores',
  '@ultimat3/notify#DigestStore': 'why: notifyStores: one member of NotifyStores',
  '@ultimat3/notify#InboxStore': 'why: notifyStores: one member of NotifyStores',
  '@ultimat3/notify#InstalledNotifyStores':
    'why: notifyStores: NotifyStores with every default filled',
  '@ultimat3/notify#PreferenceStore': 'why: notifyStores: one member of NotifyStores',
});

/** A type on `./adapter` whose name says "a backend": what the unlisted-interface rule reads. */
export const PORT_SHAPED =
  /(?:Driver|Store|Stores|Bus|Transport|Sink|Source|Gateway|Guard|Reporter|Clock|Tier|Factory|Ledger|Limiter|Provider)$/;
