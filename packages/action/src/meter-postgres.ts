/**
 * The SHARED meter store: one Postgres row per tenant × meter × period declaration, one
 * conditional `insert … on conflict` per draw, so every replica counts against one number and a
 * restart forgets nothing. Statements are spelled out so an agent can run the exact one it saw.
 */

import type { PgExecutor } from '@ultimat3/core';
import { InternalError } from '@ultimat3/core';
import { previousPeriodStart } from './meter-period';
import type { MeterDraw, MeterDrawResult, MeterKey, MeterStore } from './meter-store';

/**
 * Applied by the boot, never by an app migration — the rule `SQL_IDEMPOTENCY_TABLE` follows.
 *
 * **One row per counter, rolled over in place.** The row holds the CURRENT period only: a draw in
 * a later period resets it, so the table is bounded by tenants × meters and needs no purge — the
 * unbounded-table cost `x_rate_limit` pays (#296) is not paid twice. Usage history is not kept:
 * an app that bills on it records its own, which is a business table, not a counter.
 */
export const SQL_METER_TABLE = `
create table if not exists x_meter (
  subject      text        not null,
  meter        text        not null,
  period       text        not null,
  period_start timestamptz not null,
  used         bigint      not null,
  warned       boolean     not null default false,
  updated_at   timestamptz not null default now(),
  primary key (subject, meter, period)
);
`;

/**
 * The keys of the keyed draws that COUNTED (`drawMeter`'s `key`), this period's and the last's:
 * every keyed draw deletes its counter's older ones, so the table is bounded as `x_meter` is.
 * Applied by the boot beside `SQL_METER_TABLE`.
 */
export const SQL_METER_KEY_TABLE = `
create table if not exists x_meter_key (
  subject      text        not null,
  meter        text        not null,
  period       text        not null,
  draw_key     text        not null,
  period_start timestamptz not null,
  primary key (subject, meter, period, draw_key)
);

create index if not exists x_meter_key_period_start_idx
  on x_meter_key (subject, meter, period, period_start);
`;

/**
 * `$1` subject, `$2` meter, `$3` period key, `$4` the period start, `$5` the limit, `$6` the amount.
 *
 * Atomic and conditional in ONE statement: the `insert … select … where` admits a first draw only
 * within the limit, and `do update … where` re-checks against the row AFTER its lock is taken — a
 * direct `x_meter.used` reference, never a CTE, which would read the statement's snapshot and let
 * two racing draws both see the last free slot. No row back means refused, and nothing changed.
 *
 * `period_start` only moves FORWARD (`greatest`): a replica whose clock runs behind adds to the
 * current period instead of resetting it to the one before.
 */
const SQL_METER_DRAW = `
insert into x_meter (subject, meter, period, period_start, used, warned)
select $1, $2, $3, $4::timestamptz, $6::bigint, false
where $6::bigint <= $5::bigint
on conflict (subject, meter, period) do update set
  used = case when excluded.period_start > x_meter.period_start then $6::bigint
              else x_meter.used + $6::bigint end,
  warned = case when excluded.period_start > x_meter.period_start then false else x_meter.warned end,
  period_start = greatest(x_meter.period_start, excluded.period_start),
  updated_at = now()
where (case when excluded.period_start > x_meter.period_start then 0 else x_meter.used end)
  + $6::bigint <= $5::bigint
returning used, warned
`;

/**
 * A KEYED draw: `$1`–`$6` as above, `$7` the draw key, `$8` the start of the period before.
 *
 * The counter row is locked FIRST (`for update`, which hands back its latest committed version),
 * so every draw on one counter — every replica's — runs one at a time from here. Under that lock
 * the key is claimed only within the limit, and the count moves only when the claim landed: a key
 * that already counted (this period or the last) conflicts, and nothing is added. A refused draw
 * claims nothing, so its key is never left behind. The row must exist: `SQL_METER_ENSURE` first
 * when no row comes back. The same statement deletes the counter's keys older than `$8`.
 */
const SQL_METER_DRAW_KEYED = `
with counter as (
  select used, warned, period_start from x_meter
  where subject = $1 and meter = $2 and period = $3
  for update
),
spent as (
  select case when $4::timestamptz > period_start then 0 else used end as used,
         case when $4::timestamptz > period_start then false else warned end as warned
  from counter
),
claim as (
  insert into x_meter_key (subject, meter, period, draw_key, period_start)
  select $1, $2, $3, $7, $4::timestamptz from spent where used + $6::bigint <= $5::bigint
  on conflict (subject, meter, period, draw_key) do update set period_start = excluded.period_start
  where x_meter_key.period_start < $8::timestamptz
  returning draw_key
),
counted as (
  update x_meter set
    used = case when $4::timestamptz > period_start then $6::bigint else used + $6::bigint end,
    warned = case when $4::timestamptz > period_start then false else warned end,
    period_start = greatest(period_start, $4::timestamptz),
    updated_at = now()
  where subject = $1 and meter = $2 and period = $3 and exists (select 1 from claim)
  returning used, warned
),
purged as (
  delete from x_meter_key
  where subject = $1 and meter = $2 and period = $3 and period_start < $8::timestamptz
    and draw_key <> $7
)
select spent.used, spent.warned, spent.used + $6::bigint <= $5::bigint as within,
       counted.used as counted_used, counted.warned as counted_warned
from spent left join counted on true
`;

/** A zero counter for a keyed draw to lock — the conditional insert above cannot lock a row. */
const SQL_METER_ENSURE = `
insert into x_meter (subject, meter, period, period_start, used, warned)
values ($1, $2, $3, $4::timestamptz, 0, false)
on conflict (subject, meter, period) do nothing
`;

/**
 * Whether a refused keyed draw's key had already counted — a fresh statement, so it sees the draw
 * that took the counter's lock first and spent the allowance under this very key.
 */
const SQL_METER_KEY_COUNTED = `
select 1 from x_meter_key
where subject = $1 and meter = $2 and period = $3 and draw_key = $4
  and period_start >= $5::timestamptz
`;

/** What a refused draw is told it had used — read only on a refusal, never before a draw. */
const SQL_METER_READ = `
select used, warned from x_meter
where subject = $1 and meter = $2 and period = $3 and period_start >= $4::timestamptz
`;

/** Exactly one claimant per period: the `not warned` predicate under the row lock. */
const SQL_METER_CLAIM = `
update x_meter set warned = true
where subject = $1 and meter = $2 and period = $3 and period_start = $4::timestamptz and not warned
returning subject
`;

const SQL_METER_RELEASE = `
update x_meter set warned = false
where subject = $1 and meter = $2 and period = $3 and period_start = $4::timestamptz
`;

interface KeyedRow {
  readonly used: number | string;
  readonly warned: boolean | string;
  readonly within: boolean | string;
  readonly counted_used: number | string | null;
  readonly counted_warned: boolean | string | null;
}

interface CounterRow {
  /** `bigint`, which a client hands back as a string. */
  readonly used: number | string;
  /** `boolean`, which a text-mode client hands back as `'t'`. */
  readonly warned: boolean | string;
}

export interface PostgresMeterStoreOptions {
  readonly executor: PgExecutor;
}

const isTrue = (value: boolean | string): boolean => value === true || value === 't';
const iso = (ms: number): string => new Date(ms).toISOString();
const keyParams = (key: MeterKey, periodStartMs: number): readonly unknown[] => [
  key.subject,
  key.meter,
  key.period,
  iso(periodStartMs),
];

/**
 * Installed by the CLI boot over the pool it already opened — never the open transaction's
 * connection: a draw is the caller's whether or not the business write commits, as a handler that
 * threw may have committed and is charged for that reason.
 */
export function postgresMeterStore(options: PostgresMeterStoreOptions): MeterStore {
  const exec = options.executor;

  const drawKeyed = async (request: MeterDraw, drawKey: string): Promise<MeterDrawResult> => {
    const keptSince = iso(previousPeriodStart(request.period, request.periodStartMs));
    const params = [
      ...keyParams(request, request.periodStartMs),
      request.limit,
      request.amount ?? 1,
      drawKey,
      keptSince,
    ];
    let row = (await exec.query<KeyedRow>(SQL_METER_DRAW_KEYED, params))[0];
    if (row === undefined) {
      await exec.query(SQL_METER_ENSURE, keyParams(request, request.periodStartMs));
      row = (await exec.query<KeyedRow>(SQL_METER_DRAW_KEYED, params))[0];
    }
    if (row === undefined) {
      throw new InternalError({
        cause: `x_meter lost the counter row for meter "${request.meter}" right after it was inserted; something outside the meter store deletes x_meter rows`,
        fix: 'grep -rnE "(delete from|truncate) x_meter" .   # the boot owns x_meter: remove the statement that deletes its rows',
      });
    }
    if (row.counted_used !== null) {
      return {
        allowed: true,
        used: Number(row.counted_used),
        warned: row.counted_warned !== null && isTrue(row.counted_warned),
      };
    }
    const used = Number(row.used);
    const warned = isTrue(row.warned);
    const replayed =
      isTrue(row.within) ||
      (
        await exec.query(SQL_METER_KEY_COUNTED, [
          request.subject,
          request.meter,
          request.period,
          drawKey,
          keptSince,
        ])
      ).length === 1;
    return replayed
      ? { allowed: true, used, warned, replayed: true }
      : { allowed: false, used, warned };
  };

  return {
    scope: 'shared',

    async draw(request: MeterDraw): Promise<MeterDrawResult> {
      if (request.drawKey !== undefined) return drawKeyed(request, request.drawKey);
      const rows = await exec.query<CounterRow>(SQL_METER_DRAW, [
        ...keyParams(request, request.periodStartMs),
        request.limit,
        request.amount ?? 1,
      ]);
      const row = rows[0];
      if (row !== undefined) {
        return { allowed: true, used: Number(row.used), warned: isTrue(row.warned) };
      }
      const current = (
        await exec.query<CounterRow>(SQL_METER_READ, keyParams(request, request.periodStartMs))
      )[0];
      return {
        allowed: false,
        used: current === undefined ? 0 : Number(current.used),
        warned: current !== undefined && isTrue(current.warned),
      };
    },

    async claimWarning(key, periodStartMs): Promise<boolean> {
      const rows = await exec.query(SQL_METER_CLAIM, keyParams(key, periodStartMs));
      return rows.length === 1;
    },

    async releaseWarning(key, periodStartMs): Promise<void> {
      await exec.query(SQL_METER_RELEASE, keyParams(key, periodStartMs));
    },
  };
}
