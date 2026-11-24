/**
 * The meter's two refusals: a period's allowance spent (`X_METER_EXCEEDED`, the caller's), and a
 * declaration or a call-time limit that cannot be counted against (`X_METER_INVALID`, the app's).
 * Codes and titles stay in `error-titles.ts`'s one registration; imported bare for that reason.
 */
import { renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core/page';
import './error-titles';

export interface MeterExceededInput {
  readonly action: string;
  readonly meter: string;
  readonly period: string;
  readonly limit: number;
  readonly resetsAtMs: number;
  readonly nowMs: number;
}

/** A `drawMeter` call's refusal: no action to name, the call site is the fix. */
export type MeterDrawRefusal = Omit<MeterExceededInput, 'action'>;

/**
 * `meta.retryAfterSeconds` is the framework's one spelling of a stated delay: `@ultimat3/http`
 * renders it onto `Retry-After`, and a job's retry waits the same number.
 */
export class MeterExceededError extends UltimateError {
  constructor(input: MeterExceededInput | MeterDrawRefusal) {
    const resetsAt = new Date(input.resetsAtMs).toISOString();
    const retryAfterSeconds = Math.max(1, Math.ceil((input.resetsAtMs - input.nowMs) / 1000));
    const meterArg = renderFixShellArg(input.meter, '<meter>');
    super({
      code: 'X_METER_EXCEEDED',
      ...(!('action' in input)
        ? {
            cause: `the "${input.meter}" meter allows ${input.limit} units per ${input.period} (UTC), and this draw would pass this caller's allowance for the period; nothing was counted, and it resets at ${resetsAt}`,
            fix: `grep -rn "drawMeter(" apps/   # the call drawing "${meterArg}": raise what its limit resolves to for this tenant, or retry after meta.resetsAt`,
          }
        : {
            cause: `the "${input.meter}" meter on action "${input.action}" allows ${input.limit} calls per ${input.period} (UTC), and this caller's allowance for the period is spent; it resets at ${resetsAt}`,
            fix: `x actions show ${renderFixShellArg(input.action, '<action>')} --json   # names the meter and its period; raise what meter.limit resolves to for this tenant in the action file, or retry after meta.resetsAt`,
          }),
      callerFix: `retry after ${resetsAt} (the Retry-After header): the "${input.meter}" allowance resets then, and a larger one is the application's to grant`,
      meta: { meter: input.meter, limit: input.limit, resetsAt, retryAfterSeconds },
    });
  }
}

export type MeterField = 'name' | 'period' | 'limit' | 'warnAt' | 'amount' | 'key';

/** Where the meter was written: an action's `meter:` block, or a `drawMeter` call. */
export type MeterSite = 'action' | 'draw';

/** A meter declared — or a limit resolved — that no counter could enforce. */
export class MeterInvalidError extends UltimateError {
  constructor(
    meter: string,
    field: MeterField,
    expected: string,
    value?: unknown,
    site: MeterSite = 'action',
  ) {
    const meterArg = renderFixShellArg(meter, '<meter>');
    super({
      code: 'X_METER_INVALID',
      cause: `meter "${meter}" declares ${field}${value === undefined ? '' : ` = ${renderCauseValue(value)}`}, which is not ${expected}`,
      fix:
        site === 'draw'
          ? `drawMeter(ctx, { meter: 'tokens', period: 'day', amount: 1200, limit: ({ ctx }) => 100_000, key: run.id })   # edit the drawMeter call drawing "${meterArg}" — ${field} must be ${expected}`
          : `meter: { name: 'calls', period: 'day', limit: ({ ctx }) => 500, warnAt: 0.8, onWarn: quotaWarning }   # edit the action declaring "${meterArg}" — ${field} must be ${expected}`,
      meta: { meter, field },
    });
  }
}
