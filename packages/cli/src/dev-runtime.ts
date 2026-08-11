// Starting the services `dev-services.ts` resolved. Resolution answers "which database"; this
// answers "it is running, and every ambient accessor in the framework now points at it" — so
// `db()`, `jobDriver()`, `mailDriver()` and the realtime transport are the objects a production
// boot installs, only backed by embedded drivers.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus, JobDriver } from '@ultimat3/jobs';
import { createMemoryEventBus, setEventBus } from '@ultimat3/jobs';
import type { MailDriver } from '@ultimat3/mail';
import { isMemoryDriver, resetMailDriver, selectMailDriver, setMailDriver } from '@ultimat3/mail';
import type { Transport } from '@ultimat3/realtime';
import { InProcessTransport, NatsTransport } from '@ultimat3/realtime';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver } from '@ultimat3/storage';
import type { DevDbClient } from './dev-queue';
import { startQueue } from './dev-queue';
import type { DevServices, Env } from './dev-services';

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
  stop(): Promise<void>;
}

/**
 * `mail=embedded` is the honest report for a process that caught the message instead of sending
 * it — the same vocabulary the other three bindings use, so an operator reading a boot line sees
 * at a glance that this replica delivers nothing.
 */
export function describeMail(runtime: RunningServices): string {
  return isMemoryDriver(runtime.mail)
    ? 'mail=embedded'
    : `mail=external(${runtime.mail.name} via ${runtime.mailDetail})`;
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
 * `NATS_URL` selects the NATS transport rather than quietly keeping the in-process one: dev
 * pointed at compose is a parity check, and a parity check that silently ran the embedded driver
 * would be worse than no parity check. The connection and the KV bucket are established here, so
 * an unreachable bus fails at `x dev` rather than on the first change nobody receives.
 */
async function startTransport(services: DevServices): Promise<Transport> {
  if (services.events.mode === 'embedded') return new InProcessTransport();
  const transport = new NatsTransport({ url: services.events.url, bucket: 'x-dev' });
  await transport.connect();
  return transport;
}

/** Undo what has already started, newest first. A failure here must not hide the boot failure. */
async function unwind(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  for (const step of [...steps].reverse()) {
    try {
      await step();
    } catch {
      // The rejection that started the unwind is the one worth reporting; this one is noise.
    }
  }
}

export async function startServices(services: DevServices, env: Env): Promise<RunningServices> {
  // Before the queue: selection is pure — it parses `SMTP_URL` and builds a transport, it does
  // not dial. A typo'd credential must fail on the spot rather than after PGlite has started and
  // been unwound again, and it must fail at boot rather than on the first mail nobody receives.
  const selection = selectMailDriver(env);
  const queue = await startQueue(services);
  const { db, jobs } = queue;
  // Boot is a sequence of external resources, and every step after the first can reject — the
  // queue is already up, so from here an unwind must release it exactly like everything after it.
  const started: (() => void | Promise<void>)[] = [() => queue.stop()];
  try {
    const events = createMemoryEventBus();
    setEventBus(events);
    const transport = await startTransport(services);
    started.push(() => transport.close());
    const storage = startStorage(services);
    // With no credential this is the memory driver: caught, not sent, so the `/_x` mail panel can
    // show what a template renders in every locale without a mailbox or a message escaping to a
    // real address. `SMTP_URL` or `RESEND_API_KEY` makes it a real transport instead — the same
    // "an unset variable means the embedded default" law the other three bindings follow.
    const mail = selection.driver;
    setMailDriver(mail);
    started.push(() => resetMailDriver());

    return {
      services,
      db,
      jobs,
      events,
      transport,
      storage,
      mail,
      mailDetail: selection.detail,
      // Reverse boot order, and a stop that fails says so — only the unwind after a failed boot
      // is allowed to swallow, because there the boot error is the one worth reporting.
      async stop() {
        await transport.close();
        resetMailDriver();
        await queue.stop();
      },
    };
  } catch (error) {
    await unwind(started);
    throw error;
  }
}
