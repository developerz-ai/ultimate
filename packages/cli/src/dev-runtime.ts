// Starting the services `dev-services.ts` resolved. Resolution answers "which database"; this
// answers "it is running, and every ambient accessor in the framework now points at it" — so
// `db()`, `jobDriver()`, `mailDriver()` and the realtime transport are the objects a production
// boot installs, only backed by embedded drivers.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PgliteClient, PostgresClient, SqlFragment } from '@ultimat3/db';
import {
  createPgliteClient,
  createPostgresClient,
  pgliteDataDir,
  raw,
  setDbClient,
} from '@ultimat3/db';
import type { EventBus, JobDriver, PgExecutor } from '@ultimat3/jobs';
import {
  createMemoryEventBus,
  createPgDriver,
  SQL_JOBS_TABLE,
  setEventBus,
  setJobDriver,
} from '@ultimat3/jobs';
import type { MemoryMailDriver } from '@ultimat3/mail';
import { createMemoryDriver, resetMailDriver, setMailDriver } from '@ultimat3/mail';
import type { Transport } from '@ultimat3/realtime';
import { InProcessTransport, NatsTransport } from '@ultimat3/realtime';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver } from '@ultimat3/storage';
import type { DevServices } from './dev-services';

/** Both embedded and external clients boot lazily and close explicitly. */
export type DevDbClient = PgliteClient | PostgresClient;

export interface RunningServices {
  readonly services: DevServices;
  readonly db: DevDbClient;
  readonly jobs: JobDriver;
  readonly events: EventBus;
  readonly transport: Transport;
  readonly storage: Storage;
  readonly mail: MemoryMailDriver;
  stop(): Promise<void>;
}

const FILE_SCHEME = 'file://';

function startDb(services: DevServices): DevDbClient {
  const binding = services.db;
  const client =
    binding.mode === 'embedded'
      ? // `pgliteDataDir` is `@ultimat3/db`'s own reader of the `pglite://` form; a second parser
        // here is a second thing to keep right when the form changes.
        createPgliteClient({ dataDir: pgliteDataDir(binding.url) })
      : createPostgresClient({ url: binding.url });
  setDbClient(client);
  return client;
}

/**
 * `@ultimat3/jobs` deliberately depends on no database package: Postgres reaches it as an
 * injected `PgExecutor`. Boot code is what supplies one, and this is the boot.
 *
 * The fragment is assembled by hand rather than through `sql`` ` because the driver hands over
 * `$1..$n` text it wrote itself plus already-bound values — there is no interpolation to guard.
 */
function executorFor(client: DevDbClient): PgExecutor {
  return {
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      client.query<R>({ text, values } satisfies SqlFragment),
  };
}

/**
 * The dev queue is the real Postgres queue on the embedded Postgres — claiming, leases and the
 * one-live-job-per-key index all behave here exactly as in production. A memory queue in dev
 * would hide every bug this driver exists to make impossible.
 *
 * PGlite speaks the extended protocol, which carries one statement per round trip, so the DDL
 * is applied statement by statement. Safe to split on `;`: `SQL_JOBS_TABLE` is a fixed constant
 * with no semicolon inside a literal, and `driver-pg-sql.test.ts` is where that stays true.
 */
async function startJobs(client: DevDbClient): Promise<JobDriver> {
  for (const statement of SQL_JOBS_TABLE.split(';')) {
    if (statement.trim().length > 0) await client.execute(raw(statement));
  }
  const driver = createPgDriver({ executor: executorFor(client) });
  setJobDriver(driver);
  return driver;
}

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

export interface RunningQueue {
  readonly db: DevDbClient;
  readonly jobs: JobDriver;
  stop(): Promise<void>;
}

/**
 * The db + jobs half of `startServices`, alone: `x jobs` needs a real queue and nothing else —
 * no transport, no storage, no mail — and booting those for a command that never reports on them
 * would pay for services it cannot even use. `startServices` builds on this so there is one boot
 * path for "which database" and "which queue", not two.
 */
export async function startQueue(services: DevServices): Promise<RunningQueue> {
  const db = startDb(services);
  try {
    // Pay the Postgres boot here, so the first request is not the slow one and a broken database
    // fails at boot rather than on some later query.
    await db.ping();
    const jobs = await startJobs(db);
    return {
      db,
      jobs,
      async stop() {
        setDbClient(undefined);
        await db.close();
      },
    };
  } catch (error) {
    // `db.ping()` or `startJobs` is where a broken database is supposed to fail. Without this,
    // the caller exits holding the PGlite lock and the ambient `db()` accessor, and nothing is
    // left to release them.
    await unwind([
      async () => {
        setDbClient(undefined);
        await db.close();
      },
    ]);
    throw error;
  }
}

export async function startServices(services: DevServices): Promise<RunningServices> {
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
    // Caught, not sent: the `/_x` mail panel reads this outbox, so the local loop can check what a
    // template renders in every locale without a mailbox, an API key, or a message escaping to a
    // real address.
    const mail = createMemoryDriver();
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
