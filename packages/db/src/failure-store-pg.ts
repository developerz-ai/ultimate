// The durable failure-bundle store: `x_failures`, written OUTSIDE the request's transaction (which
// a 5xx rolled back), read by `x repro` and purged on a window the app chooses. Bundles only:
// counts per fingerprint are `x_error_groups`' (one table per fact).

import type { FailureBundle, FailureStore } from '@ultimat3/core';
import { finiteCount, isJsonObject } from '@ultimat3/core';
import type { DbClient } from './client';
import { db } from './client';
import { outsideTransaction } from './transaction';

export const FAILURES_TABLE = 'x_failures';

/**
 * Applied by the boot (`FRAMEWORK_SCHEMA`), never by an app migration, whether or not capture is
 * on — enabling it must not be the deploy that finds the table missing. `bundle` is the whole
 * `FailureBundle`; the columns beside it are the lookups `x repro` makes.
 */
export const SQL_FAILURES_TABLE = `
create table if not exists x_failures (
  id          uuid        primary key,
  fingerprint text        not null,
  code        text        not null,
  at          timestamptz not null,
  request_id  text,
  trace_id    text,
  build       text,
  primitive   text        not null,
  name        text        not null,
  bundle      jsonb       not null
);

create index if not exists x_failures_fingerprint_idx on x_failures (fingerprint, at desc);
create index if not exists x_failures_request_idx on x_failures (request_id);
create index if not exists x_failures_trace_idx on x_failures (trace_id);
create index if not exists x_failures_at_idx on x_failures (at);
`;

/** The most bundles one `list` answers. */
export const MAX_FAILURE_LIST = 200;

export interface FailureSummary {
  readonly id: string;
  readonly fingerprint: string;
  readonly code: string;
  readonly at: string;
  readonly requestId: string | null;
  readonly name: string;
  readonly build: string | null;
}

export interface PostgresFailureStore extends FailureStore {
  /** By bundle id, request id or trace id — newest first. */
  find(id: string): Promise<FailureBundle | undefined>;
  /** The newest bundle of a group. */
  latest(fingerprint: string): Promise<FailureBundle | undefined>;
  list(options?: {
    readonly code?: string;
    readonly limit?: number;
  }): Promise<readonly FailureSummary[]>;
  purge(beforeMs: number): Promise<number>;
}

interface BundleRow {
  readonly bundle: unknown;
}

const bundleOf = (rows: readonly BundleRow[]): FailureBundle | undefined => {
  const raw = rows[0]?.bundle;
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Written by `save` below from a `FailureBundle`; a row that is not an object is not one.
  return isJsonObject(parsed) ? (parsed as unknown as FailureBundle) : undefined;
};

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

export function postgresFailureStore(
  options: { readonly client?: DbClient } = {},
): PostgresFailureStore {
  const client = (): DbClient => options.client ?? db();
  // Never inside the caller's transaction: the request that failed rolled it back.
  const send = <T>(text: string, values: readonly unknown[]): Promise<readonly T[]> =>
    outsideTransaction(() => client().query<T>({ text, values: [...values] }));
  return {
    async save(bundle) {
      await send(
        `insert into ${FAILURES_TABLE} (id, fingerprint, code, at, request_id, trace_id, build, primitive, name, bundle) values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10::text::jsonb) on conflict (id) do nothing`,
        [
          bundle.id,
          bundle.fingerprint,
          bundle.code,
          new Date(bundle.at).toISOString(),
          bundle.requestId,
          bundle.traceId,
          bundle.build,
          bundle.primitive,
          bundle.name,
          JSON.stringify(bundle),
        ],
      );
    },
    async find(id) {
      return bundleOf(
        await send<BundleRow>(
          `select bundle from ${FAILURES_TABLE} where id::text = $1 or request_id = $1 or trace_id = $1 order by at desc limit 1`,
          [id],
        ),
      );
    },
    async latest(fingerprint) {
      return bundleOf(
        await send<BundleRow>(
          `select bundle from ${FAILURES_TABLE} where fingerprint = $1 order by at desc limit 1`,
          [fingerprint],
        ),
      );
    },
    async list(query = {}) {
      const limit = Math.min(
        finiteCount('postgresFailureStore.list', 'limit', query.limit ?? 50, 1),
        MAX_FAILURE_LIST,
      );
      const rows = await send<Record<string, unknown>>(
        `select id::text as id, fingerprint, code, at, request_id, name, build from ${FAILURES_TABLE}${query.code === undefined ? '' : ' where code = $2'} order by at desc limit $1`,
        query.code === undefined ? [limit] : [limit, query.code],
      );
      return rows.map((row) => ({
        id: String(row['id']),
        fingerprint: String(row['fingerprint']),
        code: String(row['code']),
        at: iso(row['at']),
        requestId: typeof row['request_id'] === 'string' ? row['request_id'] : null,
        name: String(row['name']),
        build: typeof row['build'] === 'string' ? row['build'] : null,
      }));
    },
    async purge(beforeMs) {
      const rows = await send<{ removed: number | string }>(
        `with gone as (delete from ${FAILURES_TABLE} where at < $1::timestamptz returning 1) select count(*)::int as removed from gone`,
        [new Date(beforeMs).toISOString()],
      );
      return Number(rows[0]?.removed ?? 0);
    },
  };
}

/**
 * A `purge()` target (`@ultimat3/jobs`, structural): bundles older than `keepMs`, measured on the
 * JOB's clock. No default window: how long user input may be kept is the app's decision.
 */
export function failurePurgeTarget(
  store: Pick<PostgresFailureStore, 'purge'>,
  options: { readonly keepMs: number },
): { readonly name: string; purgeExpired(nowMs: number): Promise<number> } {
  const keepMs = finiteCount('failurePurgeTarget', 'keepMs', options.keepMs, 1);
  return { name: FAILURES_TABLE, purgeExpired: (nowMs) => store.purge(nowMs - keepMs) };
}
