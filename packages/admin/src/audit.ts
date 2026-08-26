// Append-only audit log: actor, operation, entity, before/after diff, requestId, timestamp.
// If it isn't logged, it didn't happen — so denied and failed attempts are logged too, and
// there is deliberately no update or delete on this interface.

import { canonicalJson, finiteCount } from '@ultimat3/core';
import type { AdminActor, AdminDecision } from './authz';
import type { AdminRow } from './registry';

export const REDACTED = '[redacted]';

/** Named once, so both refusals below say the same thing about the same call. */
const SUBJECT = 'memoryAuditLog';

export interface AuditFieldDiff {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export type AuditOutcome = 'allowed' | 'denied' | 'failed';

export interface AuditEntry {
  readonly id: string;
  /** ISO-8601 UTC. Stored UTC, formatted per viewer zone at the edge. */
  readonly at: string;
  readonly requestId: string;
  readonly actor: { readonly id: string; readonly roles: readonly string[] };
  /** `list` | `create` | `update` | `delete`, or an action name. */
  readonly operation: string;
  readonly kind: 'operation' | 'action';
  readonly entity: string;
  readonly entityId: string | null;
  readonly permission: string;
  readonly outcome: AuditOutcome;
  /** i18n key or policy rule name explaining the outcome. */
  readonly reason: string;
  readonly diff: readonly AuditFieldDiff[];
}

export interface AuditDraft {
  readonly requestId: string;
  readonly actor: AdminActor;
  readonly operation: string;
  readonly kind: 'operation' | 'action';
  readonly entity: string;
  readonly entityId?: string | null;
  readonly permission: string;
  readonly outcome: AuditOutcome;
  readonly reason: string;
  readonly diff?: readonly AuditFieldDiff[];
}

/** Where entries go beyond memory: a table, stdout as JSON lines, an OTel log. */
export interface AuditSink {
  write(entry: AuditEntry): Promise<void> | void;
}

export interface AuditLog {
  append(draft: AuditDraft): Promise<AuditEntry>;
  /** Newest first. A copy — the log cannot be mutated through what it hands out. */
  entries(query?: {
    readonly entity?: string;
    readonly actorId?: string;
    readonly limit?: number;
  }): readonly AuditEntry[];
}

export interface AuditLogOptions {
  readonly sinks?: readonly AuditSink[];
  /** Injected so tests get deterministic timestamps and ids. */
  readonly now?: () => Date;
  readonly nextId?: () => string;
  /** Ring size. The memory log is a dev/inspection buffer, not the system of record. */
  readonly capacity?: number;
}

export function auditEntry(draft: AuditDraft, id: string, at: Date): AuditEntry {
  return {
    id,
    at: at.toISOString(),
    requestId: draft.requestId,
    actor: { id: draft.actor.id, roles: draft.actor.roles ?? [] },
    operation: draft.operation,
    kind: draft.kind,
    entity: draft.entity,
    entityId: draft.entityId ?? null,
    permission: draft.permission,
    outcome: draft.outcome,
    reason: draft.reason,
    diff: draft.diff ?? [],
  };
}

export function memoryAuditLog(opts: AuditLogOptions = {}): AuditLog {
  const now = opts.now ?? ((): Date => new Date());
  const nextId = opts.nextId ?? ((): string => crypto.randomUUID());
  // `log.length > NaN` is false for every length, so a capacity that is not a number does not make
  // the ring bigger — it removes the ring, and this buffer then grows for the life of the process.
  // At least 1, because a ring that keeps nothing is an audit log that records nothing.
  const capacity = finiteCount(SUBJECT, 'capacity', opts.capacity ?? 1000, 1);
  const sinks = opts.sinks ?? [];
  const log: AuditEntry[] = [];

  return {
    async append(draft: AuditDraft): Promise<AuditEntry> {
      // Timestamp first: the entry is stamped when it happened, not when the id generator
      // got around to it.
      const at = now();
      const entry = auditEntry(draft, nextId(), at);
      log.push(entry);
      if (log.length > capacity) log.splice(0, log.length - capacity);
      for (const sink of sinks) await sink.write(entry);
      return entry;
    },
    entries(query = {}): readonly AuditEntry[] {
      const filtered = log.filter(
        (entry) =>
          (query.entity === undefined || entry.entity === query.entity) &&
          (query.actorId === undefined || entry.actor.id === query.actorId),
      );
      const newestFirst = [...filtered].reverse();
      // The opposite failure to `capacity`, from the same missing check: `slice(0, NaN)` is `[]`,
      // so an unreadable limit answers "nothing was ever logged" and reads as a successful read.
      // 0 stays legal — asking for none is a coherent request.
      return query.limit === undefined
        ? newestFirst
        : newestFirst.slice(0, finiteCount(SUBJECT, 'entries limit', query.limit));
    },
  };
}

/**
 * "Is this field unchanged?", TOTAL over every value a row can hold.
 *
 * `JSON.stringify(a) === JSON.stringify(b)` was neither: it THROWS on a bigint, and `money()` puts
 * one on the row (`widget-value.ts` — Postgres `bigint` minor units). Two distinct
 * `{ minor, currency }` objects are never `===`, so every update of a money-bearing row reached
 * that branch and raised. `crud.ts` calls `diffRows` inside the argument to `ctx.audit.append`,
 * AFTER `repo.update()` has committed — so the write landed, the caller got an uncoded
 * `TypeError`, and the audit log recorded nothing at all.
 *
 * `canonicalJson` is tier 0, already a dependency, and already this repo's answer to exactly this
 * question (`packages/manifest/src/diff-routes.ts` asks it of a route descriptor). It is injective
 * per type, so `1000n` and `1000` stay two values rather than folding into one unchanged field.
 */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return canonicalJson(a) === canonicalJson(b);
};

/**
 * Shallow field-by-field diff of the row before and after a mutation. Only changed fields
 * appear — a diff nobody can read is a diff nobody reads. Sensitive fields are recorded as
 * having changed, with their values replaced.
 */
export function diffRows(
  before: AdminRow | null,
  after: AdminRow | null,
  opts: { readonly redact?: readonly string[] } = {},
): readonly AuditFieldDiff[] {
  const redact = new Set(opts.redact ?? []);
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: AuditFieldDiff[] = [];

  for (const field of [...names].sort()) {
    const from = before === null ? undefined : before[field];
    const to = after === null ? undefined : after[field];
    if (same(from, to)) continue;
    out.push(
      redact.has(field)
        ? {
            field,
            before: from === undefined ? undefined : REDACTED,
            after: to === undefined ? undefined : REDACTED,
          }
        : { field, before: from, after: to },
    );
  }
  return out;
}

/** The draft for a denied attempt. Denials are the entries an auditor actually wants. */
export function deniedDraft(input: {
  readonly requestId: string;
  readonly actor: AdminActor;
  readonly operation: string;
  readonly kind: 'operation' | 'action';
  readonly entity: string;
  readonly entityId?: string | null;
  readonly decision: AdminDecision;
}): AuditDraft {
  return {
    requestId: input.requestId,
    actor: input.actor,
    operation: input.operation,
    kind: input.kind,
    entity: input.entity,
    entityId: input.entityId ?? null,
    permission: input.decision.permission,
    outcome: 'denied',
    reason: input.decision.reason,
    diff: [],
  };
}
