// Starting the services `dev-services.ts` resolved. Resolution answers "which database"; this
// answers "it is running, and every ambient accessor in the framework now points at it" — so
// `db()`, `jobDriver()`, `mailDriver()` and the realtime transport are the objects a production
// boot installs, only backed by embedded drivers.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PgliteClient, PostgresClient, SqlFragment } from '@ultimat3/db';
import { createPgliteClient, createPostgresClient, raw, setDbClient } from '@ultimat3/db';
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

const PGLITE_SCHEME = 'pglite://';
const FILE_SCHEME = 'file://';

function startDb(services: DevServices): DevDbClient {
  const binding = services.db;
  const client =
    binding.mode === 'embedded'
      ? createPgliteClient({ dataDir: binding.url.slice(PGLITE_SCHEME.length) })
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
 * pointed at compose is a parity check, and a parity check that silently ran the embedded
 * driver would be worse than no parity check. The NATS transport reports its own readiness.
 */
function startTransport(services: DevServices): Transport {
  return services.events.mode === 'embedded'
    ? new InProcessTransport()
    : new NatsTransport({ url: services.events.url, bucket: 'x-dev' });
}

export async function startServices(services: DevServices): Promise<RunningServices> {
  const db = startDb(services);
  // Pay the Postgres boot here, so the first request is not the slow one and a broken database
  // fails at `x dev` rather than on some later route.
  await db.ping();
  const jobs = await startJobs(db);
  const events = createMemoryEventBus();
  setEventBus(events);
  const transport = startTransport(services);
  const storage = startStorage(services);
  // Caught, not sent: the `/_x` mail panel reads this outbox, so the local loop can check what a
  // template renders in every locale without a mailbox, an API key, or a message escaping to a
  // real address.
  const mail = createMemoryDriver();
  setMailDriver(mail);

  return {
    services,
    db,
    jobs,
    events,
    transport,
    storage,
    mail,
    async stop() {
      await transport.close();
      resetMailDriver();
      setDbClient(undefined);
      await db.close();
    },
  };
}
