// Starting the services `runtime-bindings.ts` resolved. Resolution answers "which database"; this
// answers "it is running, and every ambient accessor in the framework now points at it" — so
// `db()`, `jobDriver()`, `mailDriver()` and the realtime transport are the objects a production
// boot installs, only backed by embedded drivers. The storage disk is `runtime-storage-boot.ts`.

import { postgresAuthLimiter, postgresTotpReplayGuard } from '@ultimat3/auth';
import type { PurgeDriver } from '@ultimat3/cache';
import { isNoopPurgeDriver, selectPurgeDriver } from '@ultimat3/cache';
import {
  type RealtimeConfig,
  type Role,
  registerReadinessCheck,
  systemClock,
} from '@ultimat3/core';
import type { FailureStore } from '@ultimat3/core/adapter';
import { dbExecutor } from '@ultimat3/db';
import type { RateLimitStore } from '@ultimat3/http';
import { postgresRateLimitStore } from '@ultimat3/http';
import type { EventBus, JobDriver, OutboxStore } from '@ultimat3/jobs';
import type { MailDriver } from '@ultimat3/mail';
import { isMemoryDriver, isUnconfiguredDriver } from '@ultimat3/mail';
import type { BusUse, Transport } from '@ultimat3/realtime/server';
import type { Storage } from '@ultimat3/storage';
import { loadAppConfig } from './app-config-load';
import { msg } from './messages';
import type { DevServices, Env } from './runtime-bindings';
import { installBootPorts } from './runtime-boot-ports';
import { selectBus } from './runtime-bus';
import { cacheTiersOf, startCacheTiers } from './runtime-cache';
import { type WorkerConfig, workerConfigOf } from './runtime-jobs';
import { jobsRetentionTargets } from './runtime-jobs-retention';
import { selectAppMailDriver } from './runtime-mail';
import { inboxRetentionOf } from './runtime-notify-retention';
import type { RuntimeOverrides } from './runtime-overrides';
import { notifyStoresWithLedger, PORT_BINDINGS } from './runtime-port-bindings';
import { installPorts, suppliedOr } from './runtime-ports';
import { installRetentionSweep } from './runtime-purge';
import { installAppWebPush, selectWebPush } from './runtime-push';
import { type DevDbClient, type SchemaMode, startQueue } from './runtime-queue';
import { realtimeConfigOf } from './runtime-realtime';
import { reportStatementBound } from './runtime-statement-bound';
import { startStorage } from './runtime-storage-boot';

export interface RunningServices {
  readonly services: DevServices;
  readonly db: DevDbClient;
  readonly jobs: JobDriver;
  /** The `x_outbox` store behind `handle.enqueue()`. A role starts the relay that drains it. */
  readonly outbox: OutboxStore;
  readonly events: EventBus;
  readonly transport: Transport;
  /**
   * `app.config.ts`'s `realtime` section as this boot obeyed it: `enabled` is what `startRoles`
   * reads before it starts `sync` or a replicator. The bus is `NATS_URL`'s or `runtime.transport`.
   */
  readonly realtime: RealtimeConfig;
  /**
   * `app.config.ts`'s `jobs.queues` / `concurrency` / `visibilityTimeoutMs`, for the `worker` role —
   * the queues replaced by the boot env's `WORKER_QUEUES` when it is set (`runtime-jobs.ts`).
   * Optional because a `RunningServices` can be hand-built, and a test runtime with none keeps the
   * worker's own defaults — the answer it always got. `startServices` always sets it.
   */
  readonly workerConfig?: WorkerConfig;
  readonly storage: Storage;
  readonly mail: MailDriver;
  /**
   * Which env key selected the transport, or why nothing was selected. The credential itself is
   * never carried: `SMTP_URL` holds a password, and this string reaches the boot line and `--json`.
   */
  readonly mailDetail: string;
  /** Same rule as `mailDetail`: the env key that selected the bus, never the url behind it. */
  readonly transportDetail: string;
  /**
   * What this process does with the bus, which decided whether the boot waited for it
   * (`runtime-bus.ts`). Optional for the reason `workerConfig` is: a hand-built runtime has none.
   */
  readonly busUse?: BusUse;
  /** `x dev` booted without a bus its `sync` role needs: that role waits for it (`role-sync.ts`). */
  readonly busTolerated?: boolean;
  /**
   * What the sync role must give `PresenceRegistry`. It travels with the transport because the KV
   * bucket's age limit was derived from it — a registry given a longer TTL than the bucket honours
   * would show members leaving that never left.
   */
  readonly presenceTtlMs: number;
  /**
   * Where the HTTP rate limiter keeps its counters, over the pool this boot already opened.
   *
   * Resolved HERE and not at `startWeb` for the reason every other driver is: `startServices` is
   * what holds the connection, and a store built anywhere else would open a second pool against a
   * url this boot resolved once. Until it did, no boot installed one at all — so `rateLimit.scope`
   * derived to `'process'` on every deployment the framework produces, while `docker/helm` runs
   * `roles.web.replicas: 3` and `x new` scaffolds two.
   *
   * OPTIONAL because a `RunningServices` can be hand-built: a test's fixture runtime has a stub
   * client and no shared store, which is `httpServer`'s memory store and `scope: 'process'` —
   * the honest answer for it, and the one `startWeb` derives.
   */
  readonly rateLimitStore?: RateLimitStore;
  readonly purge: PurgeDriver;
  /**
   * `runtime.ts`'s `failureStore`, carried to the boot step that arms capture after `loadApp`
   * (`failure-capture-boot.ts`); `undefined` is its Postgres default.
   */
  readonly failureStore?: FailureStore | undefined;
  /** Same rule as `mailDetail`: the env key that selected the CDN, never the token behind it. */
  readonly purgeDetail: string;
  stop(): Promise<void>;
}

/**
 * `mail=embedded` is the honest report for a process that caught the message instead of sending
 * it — the same vocabulary the other three bindings use, so an operator reading a boot line sees
 * at a glance that this replica delivers nothing. This is the machine half: `x dev --json` carries
 * it verbatim and `wiki/Configuration.md` documents it, so it is a fixed status value and NOT a
 * catalog lookup — a translated boot line must never move a field a script parses. `mailLabel` is
 * the human half.
 */
export function describeMail(runtime: RunningServices): string {
  // Three arms, not two. A deployment with no credential outside development installs a driver that
  // REFUSES every send, and reporting that as `external` would name it as a transport that delivers
  // — the same lie the memory driver told when it answered `accepted` for mail nobody received.
  if (isUnconfiguredDriver(runtime.mail)) return `mail=refused(${runtime.mailDetail})`;
  return isMemoryDriver(runtime.mail)
    ? 'mail=embedded'
    : `mail=external(${runtime.mail.name} via ${runtime.mailDetail})`;
}

/**
 * `cdn=none` rather than `cdn=embedded`: there is no embedded CDN, and a process with no edge in
 * front of it purges nothing. Saying "embedded" would read as a fifth service this boot started.
 * Machine half, same rule as `describeMail`; `cdnLabel` is what a human reads.
 */
export function describeCdn(runtime: RunningServices): string {
  return isNoopPurgeDriver(runtime.purge)
    ? 'cdn=none'
    : `cdn=external(${runtime.purge.name} via ${runtime.purgeDetail})`;
}

/**
 * The boot line's mail label. Same fact as `describeMail`, through the catalog, because this string
 * is rendered to a person and every rendered string in the CLI is a `messages.ts` key — the status
 * value stays where `--json` can depend on it.
 */
export function mailLabel(runtime: RunningServices): string {
  if (isUnconfiguredDriver(runtime.mail))
    return msg('cli.dev.mail.refused', { detail: runtime.mailDetail });
  return isMemoryDriver(runtime.mail)
    ? msg('cli.dev.mail.embedded')
    : msg('cli.dev.mail.external', { driver: runtime.mail.name, detail: runtime.mailDetail });
}

/** The boot line's CDN label, for the reason `mailLabel` gives. */
export function cdnLabel(runtime: RunningServices): string {
  return isNoopPurgeDriver(runtime.purge)
    ? msg('cli.dev.cdn.none')
    : msg('cli.dev.cdn.external', { driver: runtime.purge.name, detail: runtime.purgeDetail });
}

/**
 * A readiness check over a dependency that can only be asked asynchronously.
 *
 * `ReadinessCheck` is synchronous and that is the mechanism, not a limitation: a probe that awaits
 * a network call takes as long as the dependency does, so a slow database makes `/readyz` miss its
 * `timeoutSeconds`, the kubelet reads that as unready, and capacity is pulled from an already
 * struggling system — the outage the probe existed to prevent, caused by the probe.
 *
 * So the read answers the PREVIOUS probe and schedules the next, which is the standard cached
 * health shape: staleness is one poll period, and the poll period is the operator's own
 * `periodSeconds`. Deliberately not a `setInterval`: a timer would probe a process nobody is
 * asking about, and in `x dev` every probe is a statement — one span, one trace id — so a
 * one-per-second heartbeat would evict every real request from `/_x/timeline` inside a minute.
 *
 * It starts `true` because it is already proven: `startQueue` pinged this pool before this line
 * ran, and a boot that could not would have thrown instead of reaching here.
 */
function probedReadinessCheck(name: string, probe: () => Promise<unknown>): () => void {
  let live = true;
  let inFlight = false;
  const refresh = (): void => {
    if (inFlight) return;
    inFlight = true;
    void probe()
      .then(
        () => {
          live = true;
        },
        // Every rejection, including the coded `X_DB_UNAVAILABLE` a closed pool answers with. A
        // check that threw would be reported as failing anyway; catching it here keeps the reason
        // out of the endpoint's own path, where nothing could report it.
        () => {
          live = false;
        },
      )
      .finally(() => {
        inFlight = false;
      });
  };
  return registerReadinessCheck(name, () => {
    refresh();
    return live;
  });
}

/**
 * Release what has already started, newest first, and return every failure instead of throwing on
 * the first: a step that rejects must not skip the ones after it, or one transport that will not
 * close strands the CDN tier, the ambient mail driver and the queue in the next boot of this
 * process. The two callers differ only in what they do with the failures.
 */
async function release(steps: readonly (() => void | Promise<void>)[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of [...steps].reverse()) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Every STOP path's form of `release`: every step runs, newest first, and the FIRST failure is
 * rethrown — it is the cause, the rest its consequences. The one helper for this process's stops
 * (`startServices`, `startRoles`, `bootServing`, `x dev`): a chain of `await`s with no `try`
 * skipped every step after one rejection, and the replicator rejects a refused close on purpose.
 * Steps are listed in BOOT order, as an unwind list is.
 */
export async function releaseOrThrow(
  steps: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const failures = await release(steps);
  if (failures.length > 0) throw failures[0];
}

interface PrepareInput {
  readonly services: DevServices;
  readonly env: Env;
  readonly overrides: RuntimeOverrides | undefined;
  readonly schema: SchemaMode;
  readonly roles: readonly Role[] | undefined;
  readonly dev: boolean;
}

/** Everything selected before a service runs, and the queue — the first thing that does. */
async function prepareServices(input: PrepareInput) {
  const { services, env, overrides, schema, roles, dev } = input;
  // The app's config is loaded ONCE, here, first, and every section below is read out of that one
  // validated object — mail's `retainMime` is the first reader, so it is loaded before mail.
  const config = await loadAppConfig(services.root);
  // Before the queue: selection is pure — it parses `SMTP_URL` and builds a transport, it does
  // not dial. A typo'd credential must fail on the spot rather than after PGlite has started and
  // been unwound again, and it must fail at boot rather than on the first mail nobody receives.
  // `mail.retainMime` rides along (`runtime-mail.ts`), refused here the same way.
  const selection = selectAppMailDriver(env, config);
  // Same reason, same place: building a purge driver reads env and dials nothing, so a half-set
  // `FASTLY_API_TOKEN` without its service id fails here rather than on the first stale page.
  const cdn = selectPurgeDriver(env);
  // Third of the same kind: `runtime.transport`, else `NATS_URL` set is NATS and unset the
  // in-process bus — a bucket name NATS cannot take refuses here, before any service. Which KV
  // bucket and which presence TTL is `@ultimat3/realtime`'s decision, and it is the same call a
  // `ROLE=sync` container makes, so this process cannot resolve the bus differently from the
  // container it stands in for. What the bus is USED for is the roles' (`runtime-bus.ts`).
  const realtime = realtimeConfigOf(config);
  // Fourth: `pwa.push` and its VAPID pair (`runtime-push.ts`). Resolving the pair reads env and
  // signs one probe — a deploy with no keys, or two halves of different pairs, refuses here.
  const push = await selectWebPush(config, env);
  const workerConfig = workerConfigOf(config, env);
  const bus = selectBus({ env, realtime, roles, override: overrides?.transport, dev });
  // `env`, not the ambient one: this function is HANDED the boot's environment and every other
  // reader here already uses it, so a queue that asked `process.env` would decide the standby from
  // a different answer than the middleware that routes to it.
  const queue = await startQueue(services, overrides, env, schema);
  return { config, selection, cdn, realtime, push, workerConfig, bus, queue };
}

type Prepared = Awaited<ReturnType<typeof prepareServices>>;

export async function startServices(
  services: DevServices,
  env: Env,
  overrides?: RuntimeOverrides,
  /** `'verify'` for a serving role on an external database — `runtime-queue.ts`'s `SchemaMode`. */
  schema: SchemaMode = 'apply',
  /**
   * The roles this process will start, which decide whether the boot waits for the bus: only a
   * `sync` node or a replicator does (`runtime-bus.ts`). Unset is the strictest reading.
   */
  roles?: readonly Role[],
  /** `x dev`: a bus the realtime roles need is waited for in the background, never refused. */
  dev = false,
): Promise<RunningServices> {
  // Before ANYTHING evaluates the app's config: `app.config.ts`'s `installSecrets()` asks the
  // secret source, and every "now" from here on reads the clock. `runtime.ts`'s, or the defaults.
  const booted = await installBootPorts(overrides);
  let prepared: Prepared;
  try {
    prepared = await prepareServices({ services, env, overrides, schema, roles, dev });
  } catch (error) {
    await release(booted);
    throw error;
  }
  const { config, selection, cdn, realtime, push, workerConfig, bus, queue } = prepared;
  const { db, jobs, outbox, events } = queue;
  await reportStatementBound(db);
  // The same executor the jobs driver, the outbox, the event bus and the idempotency store run
  // on — one pool, one `Bun.sql` that does NOT satisfy `PgExecutor` (`Bun.sql.query` is
  // `undefined`), one wrapper.
  const executor = dbExecutor(() => db);
  // Built only when `runtime.ts` is silent, so the retention sweep below expires the boot's own
  // tables and never a store the app handed over.
  const rateLimit = suppliedOr(overrides?.rateLimitStore, () =>
    postgresRateLimitStore({ executor }),
  );
  const rateLimitStore = rateLimit.value;
  const totpReplay = suppliedOr(overrides?.totpReplay, () => postgresTotpReplayGuard({ executor }));
  // Boot is a sequence of external resources, and every step after the first can reject — the
  // queue is already up, so from here an unwind must release it exactly like everything after it.
  // Which is why the `try` opens on the NEXT line and not eight steps further down: it did, and
  // the steps above it registered process-wide state (the auth limiters, the `purge()` job
  // and its `task`) that throws on a name a previous boot in this process left in the registry —
  // `X_JOB_NAME_TAKEN`, outside the unwind, so `x dev` exited holding the PGlite lock, the pool
  // and the ambient accessors. Nothing may be pushed onto `started` from outside this block.
  const started: (() => void | Promise<void>)[] = [...booted, () => queue.stop()];
  try {
    // The `services` ports, in ONE loop, BEFORE `loadApp`: `defineAuth`, `registerAction` and
    // every notifier are the app's calls and run when its modules import, so a seam filled
    // afterwards is one every app would have to fill itself.
    //
    // `authLimiter` is a FACTORY and not a limiter — the app declares `maxAttempts`/`windowMs`/
    // `lockoutMs` and this boot has not read them yet. Until it was installed here every deployment
    // counted lockouts per POD while `docker/helm` runs three: `maxAttempts × N` guesses per
    // account. `totpReplay`: a code one replica accepted must be refused by the rest.
    // `rateLimitStore`: an action's or a query's declared `rateLimit:` is counted on every surface,
    // so a task spends from the fleet's table too; `startRoles` stacks the same store again.
    // `mail`: with no credential the memory driver — caught, not sent, so the `/_x` mail panel can
    // show it; `SMTP_URL` or `RESEND_API_KEY` makes it a real transport.
    const clock = overrides?.clock ?? systemClock;
    const mail = overrides?.mail ?? selection.driver;
    started.push(
      ...(await installPorts(PORT_BINDINGS, 'services', {
        aiGateway: overrides?.aiGateway,
        auditSink: overrides?.auditSink,
        authLimiter:
          overrides?.authLimiter ?? ((policy) => postgresAuthLimiter({ executor, clock, policy })),
        // Supplied only: unset, each package's slot answers Postgres over the ambient pool.
        authServerStore: overrides?.authServerStore,
        errorReporter: overrides?.errorReporter,
        mail,
        mcpConfirmationStore: overrides?.mcpConfirmationStore,
        // Zero config still has a shared ledger: Postgres over this pool unless `runtime.ts` named one.
        notifyStores: notifyStoresWithLedger(overrides?.notifyStores, executor),
        rateLimitStore,
        scrapeDriver: overrides?.scrapeDriver,
        totpReplay: totpReplay.value,
      })),
    );
    // The hourly sweep over the framework tables this boot is responsible for. Every one of them
    // ships a `purgeExpired()` that nothing called, so every row written was a row kept —
    // `x_rate_limit` takes one upsert per request the web role serves, assets included.
    //
    // `inboxRetention` is READ HERE and not defaulted in `runtime-purge.ts`: the two windows are the
    // app's, and a loader that silently answered "never sweep" from inside the sweep would be
    // indistinguishable from an app that chose it.
    started.push(
      installRetentionSweep({
        // The boot's OWN stores only: one `runtime.ts` supplied is the app's to expire.
        idempotency: queue.idempotency,
        rateLimit: rateLimit.own,
        totpReplay: totpReplay.own,
        events,
        ...jobsRetentionTargets(executor, config),
        inboxRetention: inboxRetentionOf(config),
      }),
    );
    // One readiness check per resource this boot OWNS, released with it. Nothing in the tree
    // registered one, so `/readyz` was `markReady()` alone — "this process bound a socket" — and
    // `packages/http/src/server.ts` calls that BEFORE `Bun.serve`, while `role-start.ts` calls it
    // before `sync`, `worker` and `scheduler` start. The chart's `readinessProbe` and the container
    // healthcheck both route on it, so a replica whose pool was gone kept taking traffic.
    started.push(probedReadinessCheck('database', () => db.ping()));
    // Dialled here rather than at selection: the socket is a resource the unwind below has to
    // release. AWAITED only by a process that cannot work without the bus — a `sync` node, a
    // replicator — where an unreachable one must fail the boot, not the first change nobody
    // receives. Every other role dials in the background and boots regardless; the channel bus and
    // the `transport` readiness check are installed either way (`runtime-bus.ts`).
    const running = await bus.start();
    started.push(() => running.stop());
    const transport = running.transport;
    // Before `loadApp` for the auth limiters' reason: `pushSubscribe()` is declared when the app's
    // modules import, and reads this runtime per call.
    if (push !== undefined) {
      started.push(await installAppWebPush(push, executor, overrides?.pushSubscriptionStore));
    }
    const storage = startStorage(services, env, overrides?.storage);
    const purge = overrides?.purge ?? cdn.driver;
    // Every tier this process reads through, plus the cross-instance invalidation hop, in one
    // call. The CDN tier used to be the only one registered here — so `redisTier`,
    // `lruTier` and `memoTier` shipped with no caller at all and every replica
    // recomputed every cached read. Released with `resetTiers()`, which drops the whole registry:
    // this boot is the only thing that registers one, and a tier left behind would purge for a
    // process that has stopped.
    // The ladder is the app's declaration, never the environment's. `cache.tiers` was declared,
    // validated and documented while NOTHING read it — so an app asking for one rung got four,
    // and one asking for a shared tier got whatever `REDIS_URL` happened to say.
    const tiers = cacheTiersOf(config);
    started.push(
      startCacheTiers({ env, purge, transport, tiers, supplied: overrides?.cacheTiers }),
    );

    return {
      services,
      db,
      jobs,
      outbox,
      events,
      transport,
      realtime,
      workerConfig,
      storage,
      mail,
      mailDetail: selection.detail,
      // Built above, beside the auth limiter factory and the retention sweep that purges its
      // table: three readers of one executor, resolved once. `startWeb` is what an override
      // replaces it at.
      rateLimitStore,
      transportDetail: running.detail,
      busUse: bus.use,
      busTolerated: bus.tolerant,
      presenceTtlMs: bus.presenceTtlMs,
      purge,
      purgeDetail: cdn.detail,
      failureStore: overrides?.failureStore,
      // The same list the boot unwind uses, in the same reverse order, so a service added to the
      // boot is released by both paths — a second copy of these steps is how one of them came to
      // release three things and the other four. A stop that fails says so, unlike that unwind:
      // the FIRST failure is rethrown because it is the cause and the rest are its consequences,
      // and every step still runs, so a refused shutdown never leaks into the next boot.
      async stop() {
        await releaseOrThrow(started);
      },
    };
  } catch (error) {
    // The rejection that started the unwind is the one worth reporting; a cleanup failure under it
    // is noise, so these are collected and dropped rather than allowed to replace the cause.
    await release(started);
    throw error;
  }
}
