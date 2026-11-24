/**
 * The SHARED meter store: one Postgres row per tenant × meter × period declaration, one
 * conditional `insert … on conflict` per draw, so every replica counts against one number and a
 * restart forgets nothing. Statements are spelled out so an agent can run the exact one it saw.
 */

import type { PgExecutor } from '@ultimat3/core';
import { InternalError } from '@ultimat3/core';
import { periodOfKey, previousPeriodStart } from './meter-period';
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
 * The keys of the keyed draws that COUNTED (`drawMeter`'s `key`): one row per counted draw, this
 * period's and the last's. A refusal's probe may leave a `-infinity` placeholder only if its
 * process dies before deleting it; it never counts, and the counter's next charge purges it. A keyed draw that counts deletes its counter's older ones, so an active
 * counter holds about two periods of draws; a counter that stops receiving keyed draws keeps its
 * last rows until its next one. Size it as draws per period × 2 for the active counters, plus the
 * idle counters' last two periods. Applied by the boot beside `SQL_METER_TABLE`.
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
 * A KEYED draw: `$1`–`$6` as above, `$7` the draw key, `$8` the start of the period before the
 * request's, `$9` the period's length as an interval (`1 day`; null for a period key this store
 * cannot read, which remembers its own period only). The period before the COUNTER's is taken in
 * UTC, so a session zone cannot move a calendar boundary.
 *
 * The counter row is locked FIRST (`for update`, which hands back its latest committed version),
 * so every draw on one counter — every replica's — runs one at a time from here. Under that lock
 * the key is claimed only within the limit, and the count moves only when the claim landed: a key
 * that already counted (this period or the last) conflicts, and nothing is added. The row must
 * exist: `SQL_METER_OPEN_KEYED` when no row comes back.
 *
 * A draw past the limit still asks whether its key counted, and asks the UNIQUE INDEX (`probe`),
 * never a read: a draw that held the lock first and counted this very key committed after this
 * statement's snapshot, so a `select` cannot see its row, while `on conflict` judges the latest
 * committed one. So replay or refusal is decided under the same lock as the count it answers. A
 * probe that meets no row inserts a placeholder (`-infinity`, older than any period, so it never
 * counts and any claim takes it over), which the caller deletes with `SQL_METER_KEY_UNPROBE`.
 *
 * Every period here is the COUNTER's after the draw — `greatest` of its own and the request's — so
 * a lagging replica's draw is stamped with, and judged by, the period it is really counted in. Only
 * a draw that counted deletes the counter's keys older than the period before that one: a refused
 * draw of a later period moves no counter, and must forget nothing the counter still remembers.
 */
const SQL_METER_DRAW_KEYED = `
with counter as (
  select used, warned, period_start,
         greatest(period_start, $4::timestamptz) as effective,
         case when period_start <= $4::timestamptz then $8::timestamptz
              when $9::interval is null then period_start
              else ((period_start at time zone 'UTC') - $9::interval) at time zone 'UTC'
         end as kept_since
  from x_meter
  where subject = $1 and meter = $2 and period = $3
  for update
),
spent as (
  select case when $4::timestamptz > period_start then 0 else used end as used,
         case when $4::timestamptz > period_start then false else warned end as warned,
         effective, kept_since
  from counter
),
claim as (
  insert into x_meter_key (subject, meter, period, draw_key, period_start)
  select $1, $2, $3, $7, effective from spent where used + $6::bigint <= $5::bigint
  on conflict (subject, meter, period, draw_key) do update set period_start = excluded.period_start
  where x_meter_key.period_start < (select kept_since from spent)
  returning draw_key
),
probe as (
  insert into x_meter_key (subject, meter, period, draw_key, period_start)
  select $1, $2, $3, $7, '-infinity'::timestamptz from spent where used + $6::bigint > $5::bigint
  on conflict (subject, meter, period, draw_key) do update set period_start = x_meter_key.period_start
  where x_meter_key.period_start >= (select kept_since from spent)
  returning period_start = '-infinity'::timestamptz as placeholder
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
  where subject = $1 and meter = $2 and period = $3
    and period_start < (select kept_since from spent)
    and draw_key <> $7 and exists (select 1 from claim)
)
select spent.used, spent.warned, spent.used + $6::bigint <= $5::bigint as within,
       (extract(epoch from spent.effective) * 1000)::bigint as effective_ms,
       counted.used as counted_used, counted.warned as counted_warned,
       (select placeholder from probe) as placeholder
from spent left join counted on true
`;

/**
 * A keyed draw's FIRST counter: the row is inserted already charged, its key beside it, in one
 * statement — a zero row inserted first opened the request's period for a lagging draw to spend
 * before this draw charged it. `$1`–`$4` the counter and its period, `$5` the amount, `$6` the
 * draw key; the caller has checked the amount fits the limit. No row back: a racing draw created
 * the counter first, and the keyed draw above runs against it.
 */
const SQL_METER_OPEN_KEYED = `
with opened as (
  insert into x_meter (subject, meter, period, period_start, used, warned)
  values ($1, $2, $3, $4::timestamptz, $5::bigint, false)
  on conflict (subject, meter, period) do nothing
  returning used, warned
),
claimed as (
  insert into x_meter_key (subject, meter, period, draw_key, period_start)
  select $1, $2, $3, $6, $4::timestamptz from opened
  on conflict (subject, meter, period, draw_key) do update set period_start = excluded.period_start
)
select used, warned from opened
`;

/** A refused draw's probe placeholder, gone: `$4` the draw key. A claim that took it over keeps it. */
const SQL_METER_KEY_UNPROBE = `
delete from x_meter_key
where subject = $1 and meter = $2 and period = $3 and draw_key = $4
  and period_start = '-infinity'::timestamptz
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
  /** Epoch ms, never a timestamp: a text-mode client renders those in the session's `DateStyle`. */
  readonly effective_ms: number | string;
  readonly counted_used: number | string | null;
  readonly counted_warned: boolean | string | null;
  /** The refusal's probe: null met an uncounted key, `true` left a placeholder, `false` met a counted key. */
  readonly placeholder: boolean | string | null;
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
/** A period's length as a Postgres interval; null for a period key no shipped period spells. */
const periodInterval = (periodKey: string): string | null => {
  const period = periodOfKey(periodKey);
  return period === undefined ? null : `1 ${period}`;
};
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

  /** The locked keyed draw, opening the counter charged when there is none yet. */
  const lockedDraw = async (
    request: MeterDraw,
    drawKey: string,
    params: readonly unknown[],
  ): Promise<KeyedRow | MeterDrawResult> => {
    const row = (await exec.query<KeyedRow>(SQL_METER_DRAW_KEYED, params))[0];
    if (row !== undefined) return row;
    const amount = request.amount ?? 1;
    // No counter yet. A draw that cannot fit even an empty one is refused here, with no row: a
    // zero counter for it would open its period, and a lagging draw would then spend that one.
    if (amount > request.limit) {
      return { allowed: false, used: 0, warned: false, periodStartMs: request.periodStartMs };
    }
    const opened = (
      await exec.query<CounterRow>(SQL_METER_OPEN_KEYED, [
        ...keyParams(request, request.periodStartMs),
        amount,
        drawKey,
      ])
    )[0];
    if (opened !== undefined) {
      return {
        allowed: true,
        used: Number(opened.used),
        warned: isTrue(opened.warned),
        periodStartMs: request.periodStartMs,
      };
    }
    const raced = (await exec.query<KeyedRow>(SQL_METER_DRAW_KEYED, params))[0];
    if (raced === undefined) {
      throw new InternalError({
        cause: `x_meter lost the counter row for meter "${request.meter}" right after it was inserted; something outside the meter store deletes x_meter rows`,
        fix: 'grep -rnE "(delete from|truncate) x_meter" .   # the boot owns x_meter: remove the statement that deletes its rows',
      });
    }
    return raced;
  };

  const drawKeyed = async (request: MeterDraw, drawKey: string): Promise<MeterDrawResult> => {
    const row = await lockedDraw(request, drawKey, [
      ...keyParams(request, request.periodStartMs),
      request.limit,
      request.amount ?? 1,
      drawKey,
      iso(previousPeriodStart(request.period, request.periodStartMs)),
      periodInterval(request.period),
    ]);
    if (!('effective_ms' in row)) return row;
    const periodStartMs = Number(row.effective_ms);
    if (row.counted_used !== null) {
      return {
        allowed: true,
        used: Number(row.counted_used),
        warned: row.counted_warned !== null && isTrue(row.counted_warned),
        periodStartMs,
      };
    }
    const at = { used: Number(row.used), warned: isTrue(row.warned), periodStartMs };
    // Within the limit yet not counted: the claim met this key, already counted. Past it: the probe
    // says the same by meeting a counted key (`false`).
    if (isTrue(row.within) || (row.placeholder !== null && !isTrue(row.placeholder))) {
      return { allowed: true, ...at, replayed: true };
    }
    if (row.placeholder !== null) {
      const key = [request.subject, request.meter, request.period, drawKey];
      await exec.query(SQL_METER_KEY_UNPROBE, key);
    }
    return { allowed: false, ...at };
  };

  return {
    scope: 'shared',
    keyedDraws: true,

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
