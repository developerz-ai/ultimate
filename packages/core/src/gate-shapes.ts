// The rate-limit and audit gate SHAPES `@ultimat3/action` and `@ultimat3/query` both use: types
// and pure rules, no I/O. The siblings cannot import each other, and each spelled these rules for
// itself until they drifted; the bucket store and the sink stay with their owners.

import { type Actor, isAnonymous } from './actor';
import type { AuditFailure, AuditOutcome, AuditPrimitive, AuditSurface } from './audit';
import { isUltimateError } from './errors';

/** The line both primitives write when a sink refuses a record — one alert rule over both. */
export const AUDIT_SINK_FAILED_EVENT = 'audit.sink.failed';

/**
 * An authz refusal is `denied`; everything else that threw is `failed`. TOTAL: `isDenial` is an
 * `instanceof`, which runs a `Proxy`'s trap inside a `catch` still holding the app's error, and a
 * probe that throws there must not replace it. A value that refuses examination is not a denial.
 */
export function auditOutcomeOf(
  error: unknown,
  isDenial: (error: unknown) => boolean,
): AuditOutcome {
  try {
    return isDenial(error) ? 'denied' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Why a non-`allowed` attempt ended: its `X_*` code, or `null`, and the thrown value verbatim. */
export function auditFailureOf(error: unknown): AuditFailure {
  try {
    return { code: isUltimateError(error) ? error.code : null, error };
  } catch {
    return { code: null, error };
  }
}

/** `'server'` is app code calling its own primitive in-process: not a caller from outside. */
export function rateLimitSpendsOn(surface: AuditSurface): boolean {
  return surface !== 'server';
}

/** Namespaced, never the bare name: one key taken against two bucket shapes corrupts both. */
export function rateLimitScopeOf(kind: AuditPrimitive, name: string): string {
  return `${kind}:${name}`;
}

export interface RateLimitSubject {
  readonly actorId: string | null;
  readonly orgId: string | null;
  readonly ip: string | null;
}

/**
 * Who a spend is charged to. The org is read off an anonymous actor too: a job run IS the
 * worker's anonymous identity carrying the job's org, and charging every tenant's runs to one
 * `ip:unknown` key let one tenant's backlog refuse everyone's.
 */
export function rateLimitSubjectOf(actor: Actor, ip: string | null): RateLimitSubject {
  return {
    actorId: isAnonymous(actor) ? null : actor.id,
    orgId: actor.orgId ?? null,
    ip,
  };
}

/** A declared limit: the burst, or one resolved per call (`({ ctx }) => planOf(ctx).perMinute`). */
export interface GateRateLimit<A = unknown> {
  readonly limit: number | ((args: A) => number | Promise<number>);
  readonly windowMs: number;
}

/**
 * The number a call is held to. A non-number becomes `NaN`, so the bucket check refuses it by
 * name (`X_RATE_LIMIT_INVALID`) rather than reading it as allow-all.
 */
export async function resolvedRateLimitOf<A>(limit: GateRateLimit<A>, args: A): Promise<number> {
  const resolved: unknown =
    typeof limit.limit === 'function' ? await limit.limit(args) : limit.limit;
  return typeof resolved === 'number' ? resolved : Number.NaN;
}

/** The declaration as data a contract can diff: the fixed pair, or `null` when resolved per call. */
export function fixedRateLimitOf<A>(
  limit: GateRateLimit<A> | undefined,
): { readonly limit: number; readonly windowMs: number } | null {
  if (limit === undefined || typeof limit.limit === 'function') return null;
  return { limit: limit.limit, windowMs: limit.windowMs };
}
