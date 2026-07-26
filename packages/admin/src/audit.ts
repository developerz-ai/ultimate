// Append-only audit log: actor, operation, entity, before/after diff, requestId, timestamp.
// If it isn't logged, it didn't happen — so denied and failed attempts are logged too, and
// there is deliberately no update or delete on this interface.

import type { AdminActor, AdminDecision } from './authz';
import type { AdminRow } from './registry';

export const REDACTED = '[redacted]';

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
  const capacity = opts.capacity ?? 1000;
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
      return query.limit === undefined ? newestFirst : newestFirst.slice(0, query.limit);
    },
  };
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
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
