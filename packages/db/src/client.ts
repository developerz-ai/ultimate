// Single responsibility: the Postgres connection and the ambient `db()` handle. Pool size and
// statement timeout are chosen by runtime ROLE — a `worker` draining a queue must not size its
// pool like a `web` process behind a CDN. `Bun.SQL` is reached lazily so importing this module
// never opens a socket (the CLI imports it to print help).

import { type Role, resolveRole } from '@ultimat3/core';
import { dbUnavailable } from './errors';
import { type SqlFragment, sql } from './sql';
import { currentTx } from './transaction';

export interface DbClient {
  query<T>(fragment: SqlFragment): Promise<readonly T[]>;
  one<T>(fragment: SqlFragment): Promise<T | null>;
  /** Rows affected. */
  execute(fragment: SqlFragment): Promise<number>;
}

/** A connection pinned out of the pool. `withTransaction` needs one so BEGIN/COMMIT agree. */
export interface DbConnection extends DbClient {
  release(): void;
}

export interface ReservableClient extends DbClient {
  reserve(): Promise<DbConnection>;
}

export function isReservable(client: DbClient): client is ReservableClient {
  return typeof (client as Partial<ReservableClient>).reserve === 'function';
}

export interface PoolProfile {
  readonly max: number;
  /** 0 disables the timeout — only `migrate`, which is allowed to take as long as it takes. */
  readonly statementTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

/** Sized per role because the failure modes differ: RPS bursts vs. queue depth vs. run-once. */
export const POOL_PROFILES: Readonly<Record<Role, PoolProfile>> = Object.freeze({
  web: { max: 20, statementTimeoutMs: 10_000, idleTimeoutMs: 30_000 },
  sync: { max: 10, statementTimeoutMs: 10_000, idleTimeoutMs: 60_000 },
  worker: { max: 8, statementTimeoutMs: 120_000, idleTimeoutMs: 30_000 },
  scheduler: { max: 2, statementTimeoutMs: 15_000, idleTimeoutMs: 60_000 },
  migrate: { max: 1, statementTimeoutMs: 0, idleTimeoutMs: 10_000 },
  replicator: { max: 4, statementTimeoutMs: 0, idleTimeoutMs: 60_000 },
});

export function poolProfileFor(role: Role = resolveRole()): PoolProfile {
  return POOL_PROFILES[role];
}

/** The slice of `Bun.SQL` we use. Declared structurally so this package has no dependency. */
interface BunSqlDriver {
  unsafe(text: string, values?: readonly unknown[]): Promise<unknown>;
  close(options?: { readonly timeout?: number }): Promise<void>;
}

type BunSqlFactory = new (url: string, options?: Readonly<Record<string, unknown>>) => BunSqlDriver;

function bunSqlFactory(): BunSqlFactory {
  const host = globalThis as unknown as { readonly Bun?: { readonly SQL?: unknown } };
  const factory = host.Bun?.SQL;
  if (typeof factory !== 'function') {
    throw dbUnavailable('Bun.SQL is unavailable — this package requires Bun >= 1.3');
  }
  return factory as BunSqlFactory;
}

export interface PostgresClientOptions {
  readonly url?: string | undefined;
  readonly role?: Role | undefined;
  readonly profile?: Partial<PoolProfile> | undefined;
  readonly applicationName?: string | undefined;
}

function connectionUrl(options: PostgresClientOptions, profile: PoolProfile): string {
  const raw = options.url ?? process.env['DATABASE_URL'];
  if (raw === undefined || raw === '') {
    throw dbUnavailable('DATABASE_URL is not set, so there is no database to connect to');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw dbUnavailable(`DATABASE_URL is not a valid url: ${raw}`, error);
  }
  // libpq `options` is the portable way to pin a statement timeout for every pooled connection.
  if (profile.statementTimeoutMs > 0) {
    url.searchParams.set('options', `-c statement_timeout=${profile.statementTimeoutMs}`);
  }
  url.searchParams.set('application_name', options.applicationName ?? 'ultimate');
  return url.toString();
}

function rowsOf<T>(result: unknown): readonly T[] {
  return Array.isArray(result) ? (result as readonly T[]) : [];
}

function affectedBy(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const count = (result as { count?: unknown }).count;
  return typeof count === 'number' ? count : result.length;
}

export interface PostgresClient extends ReservableClient {
  readonly profile: PoolProfile;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Lazily connects: the pool opens on the first statement, never at import. */
export function createPostgresClient(options: PostgresClientOptions = {}): PostgresClient {
  const role = options.role ?? resolveRole();
  const profile: PoolProfile = { ...poolProfileFor(role), ...(options.profile ?? {}) };
  let driver: BunSqlDriver | undefined;

  function connect(): BunSqlDriver {
    if (driver !== undefined) return driver;
    const url = connectionUrl(options, profile);
    const Factory = bunSqlFactory();
    driver = new Factory(url, { max: profile.max, idleTimeout: profile.idleTimeoutMs / 1000 });
    return driver;
  }

  async function run(fragment: SqlFragment): Promise<unknown> {
    try {
      return await connect().unsafe(fragment.text, fragment.values);
    } catch (error) {
      throw dbUnavailable(`statement failed: ${fragment.text.slice(0, 120)}`, error);
    }
  }

  const client: PostgresClient = {
    profile,
    async query<T>(fragment: SqlFragment): Promise<readonly T[]> {
      return rowsOf<T>(await run(fragment));
    },
    async one<T>(fragment: SqlFragment): Promise<T | null> {
      const rows = rowsOf<T>(await run(fragment));
      return rows[0] ?? null;
    },
    async execute(fragment: SqlFragment): Promise<number> {
      return affectedBy(await run(fragment));
    },
    async reserve(): Promise<DbConnection> {
      // Bun pools transparently; a reservation is the seam a real pinned connection slots into.
      return { ...pickClient(client), release: () => undefined };
    },
    async ping(): Promise<void> {
      await client.query(sql`select 1`);
    },
    async close(): Promise<void> {
      await driver?.close();
      driver = undefined;
    },
  };
  return client;
}

function pickClient(client: DbClient): DbClient {
  return {
    query: (fragment) => client.query(fragment),
    one: (fragment) => client.one(fragment),
    execute: (fragment) => client.execute(fragment),
  };
}

let ambient: DbClient | undefined;

/** Test/dev seam. `setDbClient(undefined)` restores lazy construction from `DATABASE_URL`. */
export function setDbClient(client: DbClient | undefined): void {
  ambient = client;
}

/** The pool, ignoring any open transaction. `withTransaction` must not re-enter `db()`. */
export function baseClient(): DbClient {
  if (ambient === undefined) ambient = createPostgresClient();
  return ambient;
}

/**
 * The ambient client. Inside `withTransaction` this is the transaction, so a repository
 * written against `db()` joins the caller's transaction without knowing it exists.
 */
export function db(): DbClient {
  return currentTx() ?? baseClient();
}

/** Named `Db*` because `@ultimat3/core` already exports a `HealthReport` for the lifecycle. */
export interface DbHealthReport {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string | undefined;
}

/** Backs `/readyz` for every role. Never throws — the probe wants a report, not an exception. */
export async function checkDb(client: DbClient = baseClient()): Promise<DbHealthReport> {
  const started = performance.now();
  try {
    await client.query(sql`select 1`);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
