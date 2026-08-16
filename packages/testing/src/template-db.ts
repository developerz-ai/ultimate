// Real parallel database isolation: N workers, each owning a Postgres database cloned from one
// migrated template with `CREATE DATABASE ... TEMPLATE`. Never mock the database — clone it. No
// transaction-rollback wrapper (which breaks anything that commits), no shared schema with a
// `truncate` between tests (which serialises the suite and still leaks sequences).

import { TestDatabaseUnavailableError } from './errors';

export type DbKind = 'postgres' | 'pglite';

export interface SqlRunner {
  /** Run a statement that returns nothing. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface TemplateDbConfig {
  /** Connection URL with rights to CREATE DATABASE. Absent means "fall back to PGlite". */
  readonly adminUrl?: string | undefined;
  readonly templateName?: string;
  /** Applied once, into the template, under an advisory lock. */
  readonly migrate?: (url: string) => Promise<void>;
}

export interface WorkerDatabase {
  readonly kind: DbKind;
  readonly worker: number;
  readonly database: string;
  readonly url: string;
  drop(): Promise<void>;
}

export const DEFAULT_TEMPLATE = 'ultimate_test_template';

/**
 * Which database this process owns. A plain `bun test` run is one process and worker 0; a
 * `bun test --parallel=N` run is N processes and workers 1..N; an `x test --workers N` run is N
 * processes and workers 0..N-1.
 *
 * The pid fallback keeps two hand-run processes from colliding on the same database.
 */
export function workerId(env: Readonly<Record<string, string | undefined>>, pid = 0): number {
  // ULTIMATE_TEST_WORKER is checked FIRST because `x test` assigns it deliberately, one index per
  // shard, and a runner-set value must beat anything the runtime invents. That precedence is no
  // longer hypothetical: measured on Bun 1.3.14, `bun test --parallel` populates BOTH
  // BUN_TEST_WORKER_ID and JEST_WORKER_ID (identically, 1-based). So an `x test` shard that ever
  // ran its child with --parallel would otherwise resolve to Bun's index instead of its own, two
  // shards would land on one cloned database, and the failure would read as a flaky test.
  for (const key of ['ULTIMATE_TEST_WORKER', 'BUN_TEST_WORKER_ID', 'JEST_WORKER_ID']) {
    const raw = env[key];
    if (raw === undefined) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return pid === 0 ? 0 : pid % 1024;
}

export const databaseNameFor = (template: string, worker: number): string =>
  `${template}_w${worker}`;

/** Swap the database segment of a Postgres URL, keeping credentials and query parameters. */
export function urlFor(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export const createTemplateSql = (template: string): string =>
  `CREATE DATABASE "${template}" TEMPLATE template0`;

export const cloneSql = (template: string, target: string): string =>
  `CREATE DATABASE "${target}" TEMPLATE "${template}"`;

export const dropSql = (target: string): string =>
  `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`;

/** hashtext-based advisory lock: one worker migrates the template, the rest wait for it. */
export const lockSql = (template: string): string =>
  `SELECT pg_advisory_lock(hashtext('${template}'))`;

export const unlockSql = (template: string): string =>
  `SELECT pg_advisory_unlock(hashtext('${template}'))`;

export interface TemplateDbDeps {
  /** Opens an admin connection. Injected so the unit tests never need a server. */
  readonly connect: (url: string) => SqlRunner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid?: number;
}

const defaultConnect = (url: string): SqlRunner => {
  // Bun.SQL is the blessed Postgres client; no driver package, no pool config to get wrong.
  const sql = new Bun.SQL(url);
  return {
    exec: async (statement: string) => {
      await sql.unsafe(statement);
    },
    close: async () => {
      await sql.close();
    },
  };
};

/**
 * Give this worker its own database. The first caller creates and migrates the template; every
 * caller clones it. Returns a PGlite-backed handle when no Postgres is configured, so `bun test`
 * works on a laptop with nothing installed.
 */
export async function acquireWorkerDatabase(
  config: TemplateDbConfig = {},
  deps: Partial<TemplateDbDeps> = {},
): Promise<WorkerDatabase> {
  const env = deps.env ?? (Bun.env as Readonly<Record<string, string | undefined>>);
  const connect = deps.connect ?? defaultConnect;
  const template = config.templateName ?? DEFAULT_TEMPLATE;
  const worker = workerId(env, deps.pid ?? process.pid);
  const database = databaseNameFor(template, worker);
  const adminUrl = config.adminUrl ?? env['TEST_DATABASE_URL'] ?? env['DATABASE_URL'];

  if (adminUrl === undefined || adminUrl.length === 0) {
    return {
      kind: 'pglite',
      worker,
      database,
      url: `pglite://memory/${database}`,
      drop: async () => undefined,
    };
  }

  const admin = connect(adminUrl);
  try {
    await admin.exec(lockSql(template));
    try {
      try {
        await admin.exec(createTemplateSql(template));
      } catch (error) {
        // Tolerated for the CREATE alone: "already exists" means another worker got here first, or
        // a Postgres that outlives one run still holds last run's template.
        if (!alreadyExists(error)) throw error;
      }
      // Outside that tolerance on purpose, and unconditional. A template found rather than created
      // is not a migrated one — skipping here clones the first run's schema forever, on every
      // server that is not a fresh CI container. Migrations are idempotent and the advisory lock
      // serialises them, so a failure here is a real failure and `alreadyExists` (a substring match
      // on the message) would read `relation "x_jobs" already exists` as success.
      if (config.migrate !== undefined) await config.migrate(urlFor(adminUrl, template));
    } finally {
      await admin.exec(unlockSql(template));
    }
    await admin.exec(dropSql(database));
    await admin.exec(cloneSql(template, database));
  } catch (error) {
    await admin.close();
    throw new TestDatabaseUnavailableError({
      cause: `could not clone ${template} for worker ${worker}: ${messageOf(error)}`,
    });
  }
  await admin.close();

  return {
    kind: 'postgres',
    worker,
    database,
    url: urlFor(adminUrl, database),
    drop: async () => {
      const cleanup = connect(adminUrl);
      await cleanup.exec(dropSql(database));
      await cleanup.close();
    },
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const alreadyExists = (error: unknown): boolean =>
  messageOf(error).toLowerCase().includes('already exists');
