// The durable error-group store: one upsert per occurrence on `x_error_groups`, read back newest
// first. What `errorGroupsSink({ store: postgresErrorGroupsStore() })` names in a deployment with
// more than one process — the memory twin forgets at every restart and counts per replica.

import { isJsonObject } from '@ultimat3/core';
import { type DbClient, db } from '@ultimat3/db';
import { ERROR_GROUPS_TABLE } from './error-groups-schema';
import {
  ERROR_GROUP_STATUSES,
  type ErrorGroup,
  type ErrorGroupSample,
  type ErrorGroupStatus,
  type ErrorGroupsStore,
  errorGroupsLimit,
} from './error-groups-store';

const COLUMNS =
  'fingerprint, code, source, operation, message, status, first_seen, last_seen, count, sample';

/**
 * `xmax = 0` is true only on the row version an INSERT wrote: under a concurrent conflict one
 * session inserts and every other one updates, so exactly one caller reads `inserted`. A resolved
 * group re-opens here, in the same statement, so a regression can never be counted and stay shut.
 */
export const SQL_ERROR_GROUP_UPSERT = `
insert into x_error_groups as g (
  fingerprint, code, source, operation, message, status, first_seen, last_seen, count, sample
) values ($1, $2, $3, $4, $5, 'open', $6::timestamptz, $6::timestamptz, $7, $8::jsonb)
on conflict (fingerprint) do update set
  message   = excluded.message,
  status    = case when g.status = 'resolved' then 'open' else g.status end,
  last_seen = greatest(g.last_seen, excluded.last_seen),
  count     = g.count + excluded.count,
  sample    = excluded.sample
returning (xmax = 0) as inserted
`;

interface GroupRow {
  readonly fingerprint: string;
  readonly code: string;
  readonly source: string;
  readonly operation: string | null;
  readonly message: string;
  readonly status: string;
  readonly first_seen: Date | string;
  readonly last_seen: Date | string;
  readonly count: number | string | bigint;
  readonly sample: unknown;
}

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/** A `jsonb` column, whichever way the driver hands it back: parsed, or as its text. */
const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** An own string field, or `null`: a stored row is data, never a prototype to read through. */
const text = (record: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' ? value : null;
};

/** Written by this file from `ErrorGroupSample`; a hand-edited row reads as what it holds. */
function sampleOfRow(value: unknown): ErrorGroupSample {
  const record = isJsonObject(value) ? value : {};
  const meta = record['meta'];
  // Spelled apart: the stored instruction is data read back, not a `fix:` this file writes.
  const fix = text(record, 'fix') ?? '';
  return {
    at: text(record, 'at') ?? '',
    severity: text(record, 'severity') ?? 'error',
    title: text(record, 'title') ?? '',
    cause: text(record, 'cause') ?? '',
    fix,
    release: text(record, 'release'),
    environment: text(record, 'environment') ?? '',
    requestId: text(record, 'requestId'),
    traceId: text(record, 'traceId'),
    meta: isJsonObject(meta) ? meta : null,
    stack: text(record, 'stack'),
  };
}

const groupOf = (row: GroupRow): ErrorGroup => ({
  fingerprint: row.fingerprint,
  code: row.code,
  source: row.source,
  operation: row.operation,
  message: row.message,
  status: ERROR_GROUP_STATUSES.find((known) => known === row.status) ?? 'open',
  firstSeen: iso(row.first_seen),
  lastSeen: iso(row.last_seen),
  count: Number(row.count),
  sample: sampleOfRow(parsed(row.sample)),
});

export interface PostgresErrorGroupsStoreOptions {
  /** Omitted, the process's own `db()`. The sink already left any open transaction. */
  readonly client?: DbClient | undefined;
}

export function postgresErrorGroupsStore(
  options: PostgresErrorGroupsStoreOptions = {},
): ErrorGroupsStore {
  const client = (): DbClient => options.client ?? db();
  return {
    kind: 'postgres',
    async record(occurrence) {
      const rows = await client().query<{ inserted: boolean }>({
        text: SQL_ERROR_GROUP_UPSERT,
        values: [
          occurrence.fingerprint,
          occurrence.code,
          occurrence.source,
          occurrence.operation,
          occurrence.message,
          occurrence.at.toISOString(),
          occurrence.count,
          JSON.stringify(occurrence.sample),
        ],
      });
      return { isNew: rows[0]?.inserted === true };
    },
    async list(query = {}) {
      const limit = errorGroupsLimit('postgresErrorGroupsStore', query.limit);
      const filtered = query.status !== undefined;
      return (
        await client().query<GroupRow>({
          text: `select ${COLUMNS} from ${ERROR_GROUPS_TABLE}${filtered ? ' where status = $2' : ''} order by last_seen desc, fingerprint limit $1`,
          values: filtered ? [limit, query.status] : [limit],
        })
      ).map(groupOf);
    },
    async get(fingerprint) {
      const rows = await client().query<GroupRow>({
        text: `select ${COLUMNS} from ${ERROR_GROUPS_TABLE} where fingerprint = $1`,
        values: [fingerprint],
      });
      return rows[0] === undefined ? undefined : groupOf(rows[0]);
    },
    async setStatus(fingerprint, status: ErrorGroupStatus) {
      const rows = await client().query<GroupRow>({
        text: `update ${ERROR_GROUPS_TABLE} set status = $2 where fingerprint = $1 returning ${COLUMNS}`,
        values: [fingerprint, status],
      });
      return rows[0] === undefined ? undefined : groupOf(rows[0]);
    },
    async purge(beforeMs) {
      const rows = await client().query<{ removed: number | string }>({
        text: `with gone as (delete from ${ERROR_GROUPS_TABLE} where last_seen < $1::timestamptz returning 1) select count(*)::int as removed from gone`,
        values: [new Date(beforeMs).toISOString()],
      });
      return Number(rows[0]?.removed ?? 0);
    },
  };
}
