/**
 * The SHARED meter store: one Postgres row per tenant × meter × period declaration, one
 * conditional `insert … on conflict` per draw, so every replica counts against one number and a
 * restart forgets nothing. Statements are spelled out so an agent can run the exact one it saw.
 */

import type { PgExecutor } from '@ultimat3/core';
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
 * `$1` subject, `$2` meter, `$3` period key, `$4` the period start, `$5` the limit.
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
select $1, $2, $3, $4::timestamptz, 1, false
where 1 <= $5::bigint
on conflict (subject, meter, period) do update set
  used = case when excluded.period_start > x_meter.period_start then 1 else x_meter.used + 1 end,
  warned = case when excluded.period_start > x_meter.period_start then false else x_meter.warned end,
  period_start = greatest(x_meter.period_start, excluded.period_start),
  updated_at = now()
where (case when excluded.period_start > x_meter.period_start then 0 else x_meter.used end) + 1
  <= $5::bigint
returning used, warned
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
  return {
    scope: 'shared',

    async draw(request: MeterDraw): Promise<MeterDrawResult> {
      const rows = await exec.query<CounterRow>(SQL_METER_DRAW, [
        ...keyParams(request, request.periodStartMs),
        request.limit,
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
