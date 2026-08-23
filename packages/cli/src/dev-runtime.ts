// Starting the services `dev-services.ts` resolved. Resolution answers "which database"; this
// answers "it is running, and every ambient accessor in the framework now points at it" — so
// `db()`, `jobDriver()`, `mailDriver()` and the realtime transport are the objects a production
// boot installs, only backed by embedded drivers.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configureAuthLimiters, postgresAuthLimiter, resetAuthLimiters } from '@ultimat3/auth';
import type { PurgeDriver } from '@ultimat3/cache';
import { isNoopPurgeDriver, selectPurgeDriver } from '@ultimat3/cache';
import {
  isLocal,
  registerReadinessCheck,
  renderThrowable,
  resolveEnvironment,
  systemClock,
} from '@ultimat3/core';
import type { RateLimitStore } from '@ultimat3/http';
import { postgresRateLimitStore } from '@ultimat3/http';
import type { EventBus, JobDriver, OutboxStore } from '@ultimat3/jobs';
import type { MailDriver } from '@ultimat3/mail';
import {
  isMemoryDriver,
  isUnconfiguredDriver,
  resetMailDriver,
  selectMailDriver,
  setMailDriver,
} from '@ultimat3/mail';
import type { Transport, TransportSelection } from '@ultimat3/realtime/server';
import { selectTransport } from '@ultimat3/realtime/server';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver, s3Driver, usesDevStorageSecret } from '@ultimat3/storage';
import { loadCacheTiers, startCacheTiers } from './dev-cache';
import { installRetentionSweep } from './dev-purge';
import type { DevDbClient } from './dev-queue';
import { pgExecutorFor, startQueue } from './dev-queue';
import type { DevServices, Env } from './dev-services';
import { LocalDiskUnsafeError, StorageUnwritableError } from './errors';
import { msg } from './messages';
import type { RuntimeOverrides } from './runtime-overrides';

export interface RunningServices {
  readonly services: DevServices;
  readonly db: DevDbClient;
  readonly jobs: JobDriver;
  /** The `x_outbox` store behind `handle.enqueue()`. A role starts the relay that drains it. */
  readonly outbox: OutboxStore;
  readonly events: EventBus;
  readonly transport: Transport;
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
   * client and no shared store, which is `createServer`'s memory store and `scope: 'process'` —
   * the honest answer for it, and the one `startWeb` derives.
   */
  readonly rateLimitStore?: RateLimitStore;
  readonly purge: PurgeDriver;
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

const FILE_SCHEME = 'file://';

/**
 * The storage disk this process will use.
 *
 * An `external` binding now reaches `s3Driver`. It used to fall through to a LOCAL directory —
 * `S3_ENDPOINT` selected a different root and nothing else, so every deployment that configured
 * object storage silently wrote to a container-local disk, and every upload was destroyed by the
 * next restart while the configured bucket stayed empty. Nothing failed; the files just went
 * nowhere.
 *
 * The embedded branch is also where a hardened container died. `mkdirSync` on a
 * `readOnlyRootFilesystem` throws a bare `EROFS` from inside Bun's fs, with no code, no fix and no
 * mention of storage — the demo CrashLooped 22 times on it. A read-only filesystem is a normal way
 * to run a container, so this reports what to do instead of what went wrong.
 */
export function startStorage(services: DevServices, env: Env, override?: Storage): Storage {
  // First arm, not a branch beside the two below: a host that handed the boot a `Storage` has
  // already answered "which disk", and re-deriving one from `S3_ENDPOINT` would be a second answer.
  if (override !== undefined) return override;
  const binding = services.storage;

  if (binding.mode === 'external') {
    const bucket = env['S3_BUCKET'] ?? '';
    if (bucket === '') {
      throw new StorageUnwritableError(
        `S3_ENDPOINT is set to ${binding.url} but S3_BUCKET is empty, so there is no disk to write to`,
        'set S3_BUCKET to the bucket name, or unset S3_ENDPOINT to use the embedded disk',
      );
    }
    return defineStorage({
      disks: {
        object: s3Driver({
          bucket,
          endpoint: binding.url,
          ...(env['S3_REGION'] === undefined ? {} : { region: env['S3_REGION'] }),
          // MinIO needs path style; R2 and AWS do not. Declared, never sniffed from the endpoint.
          forcePathStyle: env['S3_FORCE_PATH_STYLE'] === '1',
        }),
      },
      default: 'object',
    });
  }

  const root = binding.url.slice(FILE_SCHEME.length);
  // The embedded disk is what this branch falls back to whenever `S3_ENDPOINT`/`S3_BUCKET` are
  // unset — including in `production` and `staging`, where an unset `STORAGE_SIGNING_SECRET` means
  // every signed upload grant is minted with the string published in this repo, and
  // `acceptSignedUpload` trusts a signed constraint over the app's own `uploadPolicy`.
  //
  // `localDriver` refuses that at construction on its own (`X_ENV_MISSING`). Pre-empted here so
  // the message names the STORAGE CHOICE and both ways out, rather than arriving as "a secret is
  // missing" from a helper the operator never configured. Not an outright ban on the local disk in
  // production: a single-node Compose deploy on a mounted volume WITH a real secret is a rung on
  // the scale ladder, and refusing it would be a deploy-shape decision, not a security fix.
  // `{ env }` on ALL THREE, never the ambient `process.env`: this function is HANDED the boot's
  // environment and reads `S3_BUCKET` off it one branch above, so a guard asking a second source
  // could answer `development` for a process booting as `production` — or, with
  // `usesDevStorageSecret({ env })` left bare, refuse a boot whose own env carries a real
  // `STORAGE_SIGNING_SECRET` because the PROCESS does not. Which environment, whether a secret
  // exists, and the name the message prints are one question about one table.
  if (!isLocal({ env }) && usesDevStorageSecret({ env })) {
    throw new LocalDiskUnsafeError({ environment: resolveEnvironment({ env }), root });
  }
  try {
    mkdirSync(root, { recursive: true });
  } catch (cause) {
    const detail = renderThrowable(cause);
    throw new StorageUnwritableError(
      `the embedded storage disk needs ${root} and it could not be created: ${detail}`,
      `mount a writable volume at ${root}, or set S3_ENDPOINT and S3_BUCKET to use object storage instead`,
    );
  }
  // The guard three lines up reads `env`; so must the disk it guards. Otherwise the boot's
  // environment decides whether signing is allowed and the process's decides what key is used.
  return defineStorage({ disks: { local: localDriver({ root, env }) }, default: 'local' });
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

/** A transport that says whether it is connected. NATS does; the in-process bus has nothing to be. */
interface ConnectableTransport {
  readonly connected: boolean;
}

const saysConnected = (transport: Transport): transport is Transport & ConnectableTransport =>
  typeof (transport as Partial<ConnectableTransport>).connected === 'boolean';

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

export async function startServices(
  services: DevServices,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<RunningServices> {
  // Before the queue: selection is pure — it parses `SMTP_URL` and builds a transport, it does
  // not dial. A typo'd credential must fail on the spot rather than after PGlite has started and
  // been unwound again, and it must fail at boot rather than on the first mail nobody receives.
  const selection = selectMailDriver(env);
  // Same reason, same place: building a purge driver reads env and dials nothing, so a half-set
  // `FASTLY_API_TOKEN` without its service id fails here rather than on the first stale page.
  const cdn = selectPurgeDriver(env);
  // Third of the same kind. `NATS_URL` selects the bus rather than quietly keeping the in-process
  // one — dev pointed at compose is a parity check, and a parity check that silently ran the
  // embedded driver is worse than none. Which transport, which KV bucket and which presence TTL is
  // `@ultimat3/realtime`'s decision, and it is the same call a `ROLE=sync` container makes, so this
  // process cannot resolve the bus differently from the container it stands in for.
  const bus: TransportSelection = selectTransport(env);
  const queue = await startQueue(services, overrides);
  const { db, jobs, outbox, events } = queue;
  // The same executor the jobs driver, the outbox, the event bus and the idempotency store run
  // on — one pool, one `Bun.sql` that does NOT satisfy `PgExecutor` (`Bun.sql.query` is
  // `undefined`), one wrapper.
  const executor = pgExecutorFor(db);
  const rateLimitStore = postgresRateLimitStore({ executor });
  // Boot is a sequence of external resources, and every step after the first can reject — the
  // queue is already up, so from here an unwind must release it exactly like everything after it.
  // Which is why the `try` opens on the NEXT line and not eight steps further down: it did, and
  // the steps above it registered process-wide state (`configureAuthLimiters`, the `purge()` job
  // and its `task`) that throws on a name a previous boot in this process left in the registry —
  // `X_JOB_NAME_TAKEN`, outside the unwind, so `x dev` exited holding the PGlite lock, the pool
  // and the ambient accessors. Nothing may be pushed onto `started` from outside this block.
  const started: (() => void | Promise<void>)[] = [() => queue.stop()];
  try {
    // Where failed sign-ins are counted, installed BEFORE `loadApp` for the reason the idempotency
    // store is: `defineAuth` is the app's call and it runs when the app's modules import, so a seam
    // filled afterwards is one every app would have to fill itself. A FACTORY and not a limiter —
    // the app declares `maxAttempts`/`windowMs`/`lockoutMs` and this boot has not read them yet, so
    // a limiter built here would be refused by `assertAuthLimiterPolicy` on any app that tuned one.
    //
    // Until this line every deployment the framework produces counted lockouts per POD, while
    // `x new` scaffolds `replicas: 2` and `docker/helm` runs three — `maxAttempts × N` guesses per
    // account, and a lockout one replica established invisible to the rest.
    configureAuthLimiters((policy) =>
      postgresAuthLimiter({ executor, clock: systemClock, policy }),
    );
    started.push(() => resetAuthLimiters());
    // The hourly sweep over the three framework tables this boot is responsible for. Every one of
    // them ships a `purgeExpired()` that nothing called, so every row written was a row kept —
    // `x_rate_limit` takes one upsert per request the web role serves, assets included.
    started.push(
      installRetentionSweep({ idempotency: queue.idempotency, rateLimit: rateLimitStore }),
    );
    // One readiness check per resource this boot OWNS, released with it. Nothing in the tree
    // registered one, so `/readyz` was `markReady()` alone — "this process bound a socket" — and
    // `packages/http/src/server.ts` calls that BEFORE `Bun.serve`, while `dev-roles.ts` calls it
    // before `sync`, `worker` and `scheduler` start. The chart's `readinessProbe` and the container
    // healthcheck both route on it, so a replica whose pool was gone kept taking traffic.
    started.push(probedReadinessCheck('database', () => db.ping()));
    // Dialled here rather than at selection: an unreachable bus must fail at `x dev`, not on the
    // first change nobody receives, and the socket is a resource the unwind below has to release.
    // A supplied transport is already connected and is NOT closed here: whoever built it owns its
    // socket, which is why the override skips both halves rather than only the dial.
    let transport = overrides?.transport;
    if (transport === undefined) {
      await bus.connect();
      started.push(() => bus.transport.close());
      transport = bus.transport;
    }
    // Only a transport that can be disconnected gets a check. `NatsTransport.connected` is a
    // synchronous getter over the client's own state, so no probe is needed; the in-process bus
    // has nothing to lose a connection to, and a check that can only answer `true` is a number in
    // `registered` that means nothing.
    if (saysConnected(transport)) {
      const connectable = transport;
      started.push(registerReadinessCheck('transport', () => connectable.connected));
    }
    const storage = startStorage(services, env, overrides?.storage);
    // With no credential this is the memory driver: caught, not sent, so the `/_x` mail panel can
    // show what a template renders in every locale without a mailbox or a message escaping to a
    // real address. `SMTP_URL` or `RESEND_API_KEY` makes it a real transport instead — the same
    // "an unset variable means the embedded default" law the other three bindings follow.
    const mail = overrides?.mail ?? selection.driver;
    setMailDriver(mail);
    started.push(() => resetMailDriver());
    const purge = overrides?.purge ?? cdn.driver;
    // Every tier this process reads through, plus the cross-instance invalidation hop, in one
    // call. The CDN tier used to be the only one registered here — so `createRedisTier`,
    // `createLruTier` and `createMemoTier` shipped with no caller at all and every replica
    // recomputed every cached read. Released with `resetTiers()`, which drops the whole registry:
    // this boot is the only thing that registers one, and a tier left behind would purge for a
    // process that has stopped.
    // The ladder is the app's declaration, never the environment's. `cache.tiers` was declared,
    // validated and documented while NOTHING read it — so an app asking for one rung got four,
    // and one asking for a shared tier got whatever `REDIS_URL` happened to say. `.x` is
    // `resolveServices`' own join, so its parent is the app root: the one fact this function needs
    // and does not already carry.
    const tiers = await loadCacheTiers(dirname(services.stateDir));
    started.push(startCacheTiers({ env, purge, transport, tiers }));

    return {
      services,
      db,
      jobs,
      outbox,
      events,
      transport,
      storage,
      mail,
      mailDetail: selection.detail,
      // Built above, beside the auth limiter factory and the retention sweep that purges its
      // table: three readers of one executor, resolved once. `startWeb` is what an override
      // replaces it at.
      rateLimitStore,
      // The env key that selected the bus — or the honest answer that no env key did, because a
      // boot line reading `NATS_URL` over a transport the host handed in is a lie a script parses.
      transportDetail: overrides?.transport === undefined ? bus.detail : 'runtime override',
      presenceTtlMs: bus.presenceTtlMs,
      purge,
      purgeDetail: cdn.detail,
      // The same list the boot unwind uses, in the same reverse order, so a service added to the
      // boot is released by both paths — a second copy of these steps is how one of them came to
      // release three things and the other four. A stop that fails says so, unlike that unwind:
      // the FIRST failure is rethrown because it is the cause and the rest are its consequences,
      // and every step still runs, so a refused shutdown never leaks into the next boot.
      async stop() {
        const failures = await release(started);
        if (failures.length > 0) throw failures[0];
      },
    };
  } catch (error) {
    // The rejection that started the unwind is the one worth reporting; a cleanup failure under it
    // is noise, so these are collected and dropped rather than allowed to replace the cause.
    await release(started);
    throw error;
  }
}
