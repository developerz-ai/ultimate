/**
 * An action's `meter:` declaration — a durable per-period allowance drawn inside `invoke` — and the
 * checks that refuse one that could not be enforced. The counting is `meter-gate.ts`'s; the
 * counters are the installed `MeterStore`'s. Plans, prices and what a tenant may buy are the app's.
 */

import type { Ctx } from '@ultimat3/core';
import { renderCauseValue } from '@ultimat3/core';
import { type Infer, t } from '@ultimat3/schema';
import { MeterInvalidError } from './errors-meter';

/** The periods a meter resets on. Boundaries are UTC (`meter-period.ts`), and the key says so. */
export const METER_PERIODS = Object.freeze(['hour', 'day', 'month'] as const);

export type MeterPeriod = (typeof METER_PERIODS)[number];

/** What a call-time limit is resolved from: the caller's context, never the request. */
export interface MeterLimitArgs {
  readonly ctx: Ctx;
}

/** A number, or one resolved per call from `ctx` — the tenant's plan, read by the app. */
export type ResolvedLimit = number | ((args: MeterLimitArgs) => number | Promise<number>);

/**
 * What a crossed `warnAt` hands over: one per tenant, meter and period, after the draw that
 * crossed it landed. A schema, so the job an app declares to receive it parses the same shape.
 */
export const MeterWarning = t.object({
  action: t.string,
  meter: t.string,
  orgId: t.nullable(t.string),
  actorId: t.nullable(t.string),
  used: t.number.int(),
  limit: t.number.int(),
  periodStart: t.string,
  resetsAt: t.string,
});

export type MeterWarning = Infer<typeof MeterWarning>;

/** How the warning is enqueued: outside the caller's transaction, attributed to its tenant. */
export interface MeterWarnEnqueueOptions {
  readonly outbox: false;
  readonly tenantId?: string;
}

/**
 * Where a crossed threshold goes — a `job()` from `@ultimat3/jobs` satisfies it as written. A
 * structural type, because `@ultimat3/jobs` is this package's tier and can never be imported here.
 */
export interface MeterWarnTarget {
  enqueue(warning: MeterWarning, options: MeterWarnEnqueueOptions): Promise<unknown>;
}

export interface ActionMeter {
  /** The counter's name. Two actions naming one meter with one period draw on one counter. */
  readonly name: string;
  readonly period: MeterPeriod;
  /** Calls allowed per period: a whole number, `0` refusing every call. */
  readonly limit: ResolvedLimit;
  /** The fraction of `limit` whose crossing enqueues `onWarn`, once per period. `(0, 1]`. */
  readonly warnAt?: number;
  /** Required with `warnAt`, and only with it. */
  readonly onWarn?: MeterWarnTarget;
}

/** What `describe()` publishes: the declaration minus the function and the target. */
export interface ActionMeterFact {
  readonly name: string;
  readonly period: MeterPeriod;
  readonly timeZone: 'UTC';
  /** `null` when the limit is resolved per call — no static number exists to publish. */
  readonly limit: number | null;
  readonly warnAt: number | null;
}

/** A meter name is a key in a durable table and a word in a cause: kept to a plain identifier. */
const METER_NAME = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
const METER_NAME_MAX = 64;

const isMeterPeriod = (value: unknown): value is MeterPeriod =>
  typeof value === 'string' && (METER_PERIODS as readonly string[]).includes(value);

/** A whole, non-negative, exactly representable count of calls. */
export const isMeterLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** At `action()`: a meter that could not be counted is refused where it is written. */
export function assertMeterDeclaration(meter: ActionMeter): void {
  const name: unknown = meter.name;
  if (typeof name !== 'string' || name.length > METER_NAME_MAX || !METER_NAME.test(name)) {
    const shown = typeof name === 'string' ? name : renderCauseValue(name);
    throw new MeterInvalidError(shown, 'name', 'a camelCase identifier of at most 64 chars');
  }
  if (!isMeterPeriod(meter.period)) {
    throw new MeterInvalidError(name, 'period', `one of ${METER_PERIODS.join(' | ')}`);
  }
  if (typeof meter.limit !== 'function' && !isMeterLimit(meter.limit)) {
    throw new MeterInvalidError(name, 'limit', 'a whole number of calls, 0 or more');
  }
  const warnAt: unknown = meter.warnAt;
  if (warnAt !== undefined) {
    if (typeof warnAt !== 'number' || !Number.isFinite(warnAt) || warnAt <= 0 || warnAt > 1) {
      throw new MeterInvalidError(name, 'warnAt', 'a fraction of the limit in (0, 1]');
    }
  }
  // Half a pair is a declaration that does nothing: a threshold nobody hears, or a listener
  // nothing ever calls. Refused rather than read as "warn nowhere".
  if ((warnAt === undefined) !== (meter.onWarn === undefined)) {
    throw new MeterInvalidError(name, 'warnAt', 'declared together with onWarn, or neither');
  }
}

export function meterFact(meter: ActionMeter | undefined): ActionMeterFact | null {
  if (meter === undefined) return null;
  return {
    name: meter.name,
    period: meter.period,
    timeZone: 'UTC',
    limit: typeof meter.limit === 'function' ? null : meter.limit,
    warnAt: meter.warnAt ?? null,
  };
}
