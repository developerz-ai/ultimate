/**
 * The audit seam: THAT an action or mutator can be recorded at all. One `AuditSink`, installed
 * once, handed every fact `invoke` genuinely knows about an attempt — who acted, which primitive,
 * when, on which surface, with which idempotency key, and whether it was allowed, denied or
 * failed. What the ROW says — its fields, its retention, its hash chain, its subject index, what
 * "who" means under impersonation — is the app's, and this file declares none of it.
 */

import type { Ctx } from '@ultimat3/core';
import type { Surface } from './policy-gate';

/**
 * The three things that can happen to an attempt. Deliberately the same three words
 * `@ultimat3/admin`'s `AuditEntry` uses — that package is tier 5 and this one is tier 3, so the
 * vocabulary is shared by name and not by import. `denied` is an authz refusal, `failed` is
 * everything else that threw, including an input that never parsed.
 */
export type AuditOutcome = 'allowed' | 'denied' | 'failed';

/** Why a non-`allowed` attempt ended. The framework classifies; it never renders. */
export interface AuditFailure {
  /** The `X_*` code when an `UltimateError` ended it; `null` for anything else that threw. */
  readonly code: string | null;
  /** The thrown value, verbatim — its stack is the thing worth reading. */
  readonly error: unknown;
}

/**
 * One attempt, as the framework observed it. Every field here is something `invoke` already
 * holds; nothing on it is a guess about the business.
 *
 * `result` is deliberately absent. A handler's return value is reachable from the handler
 * itself, on the one outcome that has one — so shipping it would be the framework deciding the
 * row carries an after-image, which is the first field of an audit ENTITY. `input` is present
 * for the opposite reason: on a `denied` record the handler never ran, so nothing in app code
 * can recover what was attempted, and that is the record an auditor actually wants.
 */
export interface AuditRecord {
  /**
   * When the attempt began, from `ctx.now()` — never `new Date()`. An instant, not a rendering:
   * serialising it (ISO, epoch, a Postgres `timestamptz`) is the app's decision, and it is the
   * app that knows the zone anything is displayed in.
   */
  readonly at: Date;
  /** The registered export name. A mutator carries the name of its action half. */
  readonly action: string;
  /** True when `mutator()` built it. Which primitive acted is a framework fact. */
  readonly mutator: boolean;
  /** Which projection ran it: a price change over `http` and one over `mcp` are not the same event. */
  readonly surface: Surface;
  /**
   * The context the attempt ran in — actor, `requestId`, `traceId`, locale, and the service bag
   * a sink needs to write a row at all. Carried whole rather than projected into `actorId` +
   * `requestId` fields, because choosing WHICH context facts an audit row keeps is precisely the
   * convention four apps modelled four ways.
   *
   * **A sink that PERSISTS must project it, and `audit-postgres.ts` is where that is done.**
   * `createContext` spreads every installed service onto this object and an HTTP surface's value
   * is a `RequestContext` carrying the caller's `Authorization` and `Cookie`, so writing it down
   * whole puts an app's database clients and its caller's credentials in a table. Whole here,
   * allow-listed there — the seam hands over everything and each sink decides what it keeps.
   */
  readonly ctx: Ctx;
  /**
   * The PARSED input, or `undefined` when the parse is what failed. Never the raw payload:
   * an unvalidated body is attacker-shaped, and handing one to a sink that writes it to a table
   * is how an audit trail becomes an injection surface.
   */
  readonly input: unknown;
  /** The namespaced key an `idempotent` action was retried under, or `null`. */
  readonly idempotencyKey: string | null;
  /** True when the response was replayed from an earlier settled record — a call, not a write. */
  readonly replayed: boolean;
  readonly outcome: AuditOutcome;
  /** Present exactly when `outcome !== 'allowed'`. */
  readonly failure: AuditFailure | null;
}

/**
 * Where a record goes. The app's implementation: a table, an append-only hash chain, an OTel
 * log, a queue. `@ultimat3/admin`'s `AuditSink` is the same noun one tier up, over its own
 * fixed entry type; this one carries no `AdminActor` and no `permission`, because an action
 * outside `/admin` has neither.
 *
 * A sink that throws is never swallowed — see `audit-gate.ts` for which failure wins.
 */
export interface AuditSink {
  write(record: AuditRecord): Promise<void> | void;
}

/**
 * No default. A logger-backed default would satisfy `audit: true` with a line nobody stores,
 * which is the silent pass this seam exists to remove: an audited action with no sink installed
 * is `X_AUDIT_SINK_MISSING`, refused before the handler runs.
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
