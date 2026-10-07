/**
 * The audit seam every primitive shares: the record an audited attempt produces, the sink it goes
 * to, and the one installed-sink slot. Here at tier 0 so `@ultimat3/action` and `@ultimat3/query`
 * — siblings that cannot import each other — write one contract into one sink. What the ROW says
 * (retention, hash chain, subject index, "who" under impersonation) is the app's; none of it is here.
 */

import type { Ctx } from './context';

/**
 * The three things that can happen to an attempt. Deliberately the same three words
 * `@ultimat3/admin`'s `AuditEntry` uses — that package is tier 5, so the vocabulary is shared by
 * name and not by import. `denied` is an authz refusal, `failed` is everything else that threw,
 * including an input that never parsed.
 */
export type AuditOutcome = 'allowed' | 'denied' | 'failed';

/** Which primitive acted — the value of the `ultimate.primitive` span attribute, too. */
export type AuditPrimitive = 'action' | 'query';

/**
 * Which projection ran the attempt: a price change over `http` and one over `mcp` are not the same
 * event. The union of the action surfaces (`server`, `http`, `mcp`, `job`) and the read surfaces
 * (`server`, `http`, `mcp`, `live`) — one sink receives both.
 */
export type AuditSurface = 'server' | 'http' | 'mcp' | 'job' | 'live';

/** Why a non-`allowed` attempt ended. The framework classifies; it never renders. */
export interface AuditFailure {
  /** The `X_*` code when an `UltimateError` ended it; `null` for anything else that threw. */
  readonly code: string | null;
  /** The thrown value, verbatim — its stack is the thing worth reading. */
  readonly error: unknown;
}

/**
 * One attempt, as the framework observed it. Every field is something the primitive's one path
 * already holds; nothing on it is a guess about the business.
 *
 * A result is deliberately absent — an action's return value and a read's rows alike. Shipping it
 * would be the framework deciding the row carries an after-image (for a read: a copy of every row
 * an auditor's table then has to protect as carefully as the source). `input` is present for the
 * opposite reason: on a `denied` record nothing ran, so nothing in app code can recover what was
 * attempted, and that is the record an auditor actually wants.
 */
export interface AuditRecord {
  /**
   * When the attempt began, from `ctx.now()` — never `new Date()`. An instant, not a rendering:
   * serialising it is the app's decision, and it is the app that knows the zone it is shown in.
   */
  readonly at: Date;
  /**
   * The registered export name of the primitive that acted. A mutator carries its action half's.
   * Required since 25.0.0, which also dropped the `action` alias this field replaced: one name,
   * one spelling (plan 101, M9). `@ultimat3/action`'s durable sink still files it in the
   * `x_audit.action` column — a column rename is a data migration, and the value is the same.
   */
  readonly name: string;
  /** `'action'` (a mutator included — see `mutator`) or `'query'`. A read and a write are not one event. */
  readonly primitive: AuditPrimitive;
  /** True when `mutator()` built it. Always false for a query. */
  readonly mutator: boolean;
  readonly surface: AuditSurface;
  /**
   * The context the attempt ran in — actor, `requestId`, `traceId`, locale, and the service bag a
   * sink needs to write a row at all. Carried whole, because choosing WHICH context facts a row
   * keeps is precisely the convention four apps modelled four ways.
   *
   * **A sink that PERSISTS must project it** (`@ultimat3/action`'s `postgresAuditSink` is the
   * shipped allow-list): `createContext` spreads every installed service onto this object and an
   * HTTP surface's value carries the caller's `Authorization` and `Cookie`.
   */
  readonly ctx: Ctx;
  /**
   * The PARSED input, or `undefined` when the parse is what failed. Never the raw payload: an
   * unvalidated body is attacker-shaped. Unredacted — a persisting sink redacts through
   * `auditableInput`, the walk core's `isRedactedKey` table and `Secret` decide.
   */
  readonly input: unknown;
  /** The namespaced key an `idempotent` action was retried under, or `null`. Always `null` for a read. */
  readonly idempotencyKey: string | null;
  /**
   * True when the answer came from an earlier settled execution rather than this call's own: an
   * idempotent action's stored response, or a read served by the request memo or a cache tier.
   * A call, not a write — and, for a read, still a sighting.
   */
  readonly replayed: boolean;
  readonly outcome: AuditOutcome;
  /** Present exactly when `outcome !== 'allowed'`. */
  readonly failure: AuditFailure | null;
}

/**
 * Every field of `AuditRecord`, as data — the pin both primitives' tests hold their records to, so
 * a field one of them forgets to write is a red test in that package and not a hole in a table.
 * Spelled as a `Record` over `keyof AuditRecord` so a field missing here, or one that is not on the
 * record, is a typecheck error in this file.
 */
const FIELDS: Readonly<Record<keyof AuditRecord, true>> = {
  at: true,
  name: true,
  primitive: true,
  mutator: true,
  surface: true,
  ctx: true,
  input: true,
  idempotencyKey: true,
  replayed: true,
  outcome: true,
  failure: true,
};

export const AUDIT_RECORD_FIELDS: readonly (keyof AuditRecord)[] = Object.freeze(
  Object.keys(FIELDS) as (keyof AuditRecord)[],
);

/**
 * Where a record goes: a table, an append-only hash chain, an OTel log, a queue — the app's.
 * `@ultimat3/admin`'s `AuditSink` is the same noun one tier up over its own fixed entry type.
 * A sink that throws is never swallowed; each primitive's audit gate says which failure wins.
 */
export interface AuditSink {
  write(record: AuditRecord): Promise<void> | void;
}

/**
 * No default. A logger-backed default would satisfy `audit: true` with a line nobody stores, which
 * is the silent pass this seam exists to remove: an audited primitive with no sink installed is
 * refused before it reads its input (`X_AUDIT_SINK_MISSING`, `X_QUERY_AUDIT_SINK_MISSING`).
 */
let installed: AuditSink | null = null;

export function setAuditSink(sink: AuditSink): void {
  installed = sink;
}

export function getAuditSink(): AuditSink | null {
  return installed;
}

/** Test seam: back to "nothing installed", which restoring a literal cannot express. */
export function resetAuditSink(): void {
  installed = null;
}
