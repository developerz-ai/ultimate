// Starting the services `dev-services.ts` resolved. Resolution answers "which database"; this
// answers "it is running, and every ambient accessor in the framework now points at it" — so
// `db()`, `jobDriver()`, `mailDriver()` and the realtime transport are the objects a production
// boot installs, only backed by embedded drivers.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PurgeDriver } from '@ultimat3/cache';
import {
  createCdnTier,
  isNoopPurgeDriver,
  registerTier,
  resetTiers,
  selectPurgeDriver,
} from '@ultimat3/cache';
import type { EventBus, JobDriver } from '@ultimat3/jobs';
import { createMemoryEventBus, setEventBus } from '@ultimat3/jobs';
import type { MailDriver } from '@ultimat3/mail';
import { isMemoryDriver, resetMailDriver, selectMailDriver, setMailDriver } from '@ultimat3/mail';
import type { Transport, TransportSelection } from '@ultimat3/realtime';
import { selectTransport } from '@ultimat3/realtime';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver } from '@ultimat3/storage';
import type { DevDbClient } from './dev-queue';
import { startQueue } from './dev-queue';
import type { DevServices, Env } from './dev-services';
import { msg } from './messages';

export interface RunningServices {
  readonly services: DevServices;
  readonly db: DevDbClient;
  readonly jobs: JobDriver;
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

function startStorage(services: DevServices): Storage {
  const binding = services.storage;
  const root =
    binding.mode === 'embedded'
      ? binding.url.slice(FILE_SCHEME.length)
      : join(services.stateDir, 'storage');
  mkdirSync(root, { recursive: true });
  return defineStorage({ disks: { local: localDriver({ root }) }, default: 'local' });
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

export async function startServices(services: DevServices, env: Env): Promise<RunningServices> {
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
  const queue = await startQueue(services);
  const { db, jobs } = queue;
  // Boot is a sequence of external resources, and every step after the first can reject — the
  // queue is already up, so from here an unwind must release it exactly like everything after it.
  const started: (() => void | Promise<void>)[] = [() => queue.stop()];
  try {
    const events = createMemoryEventBus();
    setEventBus(events);
    // Dialled here rather than at selection: an unreachable bus must fail at `x dev`, not on the
    // first change nobody receives, and the socket is a resource the unwind below has to release.
    await bus.connect();
    started.push(() => bus.transport.close());
    const storage = startStorage(services);
    // With no credential this is the memory driver: caught, not sent, so the `/_x` mail panel can
    // show what a template renders in every locale without a mailbox or a message escaping to a
    // real address. `SMTP_URL` or `RESEND_API_KEY` makes it a real transport instead — the same
    // "an unset variable means the embedded default" law the other three bindings follow.
    const mail = selection.driver;
    setMailDriver(mail);
    started.push(() => resetMailDriver());
    // Registered only when a credential named a real edge. A noop tier would put a `cdn` line in
    // every invalidation report claiming keys an edge that does not exist had accepted — and the
    // `/_x` cache panel renders those reports, so the lie would be the thing an agent reads.
    // Released with `resetTiers()`, which drops the whole registry: this boot is the only thing
    // that registers one, and a tier left behind would purge for a process that has stopped.
    const purging = !isNoopPurgeDriver(cdn.driver);
    if (purging) {
      registerTier(createCdnTier({ purge: cdn.driver }));
      started.push(() => resetTiers());
    }

    return {
      services,
      db,
      jobs,
      events,
      transport: bus.transport,
      storage,
      mail,
      mailDetail: selection.detail,
      transportDetail: bus.detail,
      presenceTtlMs: bus.presenceTtlMs,
      purge: cdn.driver,
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
