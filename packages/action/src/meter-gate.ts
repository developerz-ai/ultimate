/**
 * Where a declared `meter:` is drawn: once per call, inside `invoke`, on EVERY surface — HTTP, MCP,
 * a job, an in-process call — after the policy admitted it and before the handler starts. A
 * refusal is `X_METER_EXCEEDED`; a crossed `warnAt` enqueues the app's `onWarn` once per period.
 */

import type { Ctx } from '@ultimat3/core';
import { isAnonymous, logger } from '@ultimat3/core';
import { MeterExceededError, MeterInvalidError } from './errors-meter';
import type { ActionMeter, MeterWarning, ResolvedLimit } from './meter';
import { isMeterLimit } from './meter';
import { meterPeriodKey, meterWindow } from './meter-period';
import type { MeterKey, MeterStore } from './meter-store';
import { getMeterStore } from './meter-store';
import { inJobFrame, UNATTRIBUTED_JOB } from './rate-limit-gate';

/**
 * Whose counter: the tenant, else the signed-in actor, else ONE shared counter per population —
 * refused together rather than unlimited, the rate limiter's rule for a caller with nothing to key
 * on. A job run carries its org on the worker's anonymous actor (`jobRunActor`), so it counts
 * there; a tenantless one counts as `job:unattributed`, never on the anonymous visitors' counter.
 */
export function meterSubject(ctx: Ctx): string {
  const orgId = ctx.actor.orgId;
  if (typeof orgId === 'string' && orgId !== '') return `org:${orgId}`;
  if (!isAnonymous(ctx.actor)) return `actor:${ctx.actor.id}`;
  return inJobFrame() ? UNATTRIBUTED_JOB : 'anonymous';
}

/** A call-time limit, checked: `NaN`, a fraction or a negative is the app's bug, never allow-all. */
export async function resolveMeterLimit(
  meter: string,
  limit: ResolvedLimit,
  ctx: Ctx,
): Promise<number> {
  const resolved: unknown = typeof limit === 'function' ? await limit({ ctx }) : limit;
  if (!isMeterLimit(resolved)) {
    throw new MeterInvalidError(meter, 'limit', 'a whole number of calls, 0 or more', resolved);
  }
  return resolved;
}

/** Draw one call from `meter` for this caller, or throw `X_METER_EXCEEDED`. */
export async function drawMeter(
  action: string,
  meter: ActionMeter,
  ctx: Ctx,
  store: MeterStore = getMeterStore(),
): Promise<void> {
  const limit = await resolveMeterLimit(meter.name, meter.limit, ctx);
  const nowMs = ctx.now().getTime();
  const window = meterWindow(meter.period, nowMs);
  const key: MeterKey = {
    subject: meterSubject(ctx),
    meter: meter.name,
    period: meterPeriodKey(meter.period),
  };
  const drawn = await store.draw({ ...key, periodStartMs: window.startMs, limit });
  if (!drawn.allowed) {
    throw new MeterExceededError({
      action,
      meter: meter.name,
      period: meter.period,
      limit,
      resetsAtMs: window.endMs,
      nowMs,
    });
  }
  // After the increment landed, never before: a warning for a draw that was refused is a warning
  // about usage that never happened.
  if (meter.warnAt === undefined || meter.onWarn === undefined || drawn.warned) return;
  if (drawn.used < Math.ceil(meter.warnAt * limit)) return;
  if (!(await store.claimWarning(key, window.startMs))) return;
  const warning: MeterWarning = {
    action,
    meter: meter.name,
    orgId: ctx.actor.orgId ?? null,
    actorId: isAnonymous(ctx.actor) ? null : ctx.actor.id,
    used: drawn.used,
    limit,
    periodStart: new Date(window.startMs).toISOString(),
    resetsAt: new Date(window.endMs).toISOString(),
  };
  try {
    // Outside the caller's transaction: the claim above is already durable, and a warning staged
    // in a transaction that rolls back would be a claim nothing ever delivers.
    await meter.onWarn.enqueue(warning, {
      outbox: false,
      ...(warning.orgId === null ? {} : { tenantId: warning.orgId }),
    });
  } catch (error) {
    // The call is owed its answer: its draw counted and the handler is about to run, so a warning
    // that could not be queued never fails it. The claim goes back, so the next draw retries.
    logger.error('action.meter.warn-failed', { action, meter: meter.name, error });
    await store.releaseWarning(key, window.startMs).catch((releaseError: unknown) => {
      logger.error('action.meter.warn-release-failed', {
        action,
        meter: meter.name,
        error: releaseError,
      });
    });
  }
}
