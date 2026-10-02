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
  readonly actor: {
    readonly id: string;
    readonly roles: readonly string[];
    /** The tenant the actor acted under. Absent for a single-tenant app. */
    readonly orgId?: string;
  };
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

/** Where a copy of every entry goes besides the log's own store: stdout as JSON lines, OTel. */
export interface AuditSink {
  write(entry: AuditEntry): Promise<void> | void;
}

/** A position in the trail: the entry a page ended on. Entries are ordered `at` then `id`. */
export interface AuditCursor {
  readonly at: string;
  readonly id: string;
}

export interface AuditQuery {
  readonly entity?: string;
  /** One row's trail — what the detail page's history card asks, with `entity`. */
  readonly entityId?: string;
  readonly actorId?: string;
  /** Only entries written by an actor of this tenant. */
  readonly orgId?: string;
  readonly limit?: number;
  /** Keyset: only entries strictly OLDER than this one. There is no offset. */
  readonly before?: AuditCursor;
  /**
   * Leave out the reads that were allowed — `list`, `detail`, `search`, a page — and keep what
   * changed something or was refused. What a row's history shows.
   */
  readonly changes?: boolean;
}

export interface AuditLog {
  append(draft: AuditDraft): Promise<AuditEntry>;
  /**
   * Newest first, at most `limit` (`AUDIT_PAGE_MAX` at the outside). A copy — the log cannot be
   * mutated through what it hands out. Async because the record is a table, not this process.
   */
  entries(query?: AuditQuery): Promise<readonly AuditEntry[]>;
  /**
   * Run a write and its entry as ONE unit where the store can: a durable log opens a transaction,
   * so a row never changes without its entry and an entry never names a write that rolled back.
   * The memory log has nothing to join and runs `run` as it is.
   */
  atomic<T>(run: () => Promise<T>): Promise<T>;
  /** `memory`, `postgres`, or an app's own word. What the manifest records about this admin. */
  readonly kind: string;
}

export interface AuditLogOptions {
  readonly sinks?: readonly AuditSink[];
  /** Injected so tests get deterministic timestamps and ids. */
  readonly now?: () => Date;
  readonly nextId?: () => string;
  /** Ring size. The memory log is a dev/inspection buffer, not the system of record. */
  readonly capacity?: number;
}

/** The most entries one read answers, whatever it asked for. */
export const AUDIT_PAGE_MAX = 200;

/** What a read answers when it names no limit. */
export const AUDIT_PAGE_DEFAULT = 100;

/** The operations that only LOOK. An allowed one is a read; a refused one is still an event. */
export const AUDIT_READ_OPERATIONS: readonly string[] = ['list', 'detail', 'search', 'page'];

/** An entry that changed nothing and was refused nothing — the only kind `changes` leaves out. */
export const isAllowedRead = (entry: AuditEntry): boolean =>
  entry.kind === 'operation' &&
  entry.outcome === 'allowed' &&
  AUDIT_READ_OPERATIONS.includes(entry.operation);

/** The page size a query asks for, bounded. Refused when it is not a count at all. */
export const auditLimit = (subject: string, query: AuditQuery): number =>
  Math.min(
    AUDIT_PAGE_MAX,
    query.limit === undefined
      ? AUDIT_PAGE_DEFAULT
      : // `slice(0, NaN)` is `[]`: an unreadable limit would answer "nothing was ever logged".
        // 0 stays legal — asking for none is a coherent request.
        finiteCount(subject, 'entries limit', query.limit),
  );

/** Where the page after `entries` starts, or `null` for an empty page. */
export const auditCursorOf = (entries: readonly AuditEntry[]): AuditCursor | null => {
  const last = entries[entries.length - 1];
  return last === undefined ? null : { at: last.at, id: last.id };
};

/** `-1` when `a` is NEWER than `b`: the trail's one order, `at` then `id`, both descending. */
const newestFirst = (a: AuditCursor, b: AuditCursor): number =>
  a.at === b.at ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1) : a.at > b.at ? -1 : 1;

export function auditEntry(draft: AuditDraft, id: string, at: Date): AuditEntry {
  return {
    id,
    at: at.toISOString(),
    requestId: draft.requestId,
    actor: {
      id: draft.actor.id,
      roles: draft.actor.roles ?? [],
      ...(draft.actor.orgId === undefined ? {} : { orgId: draft.actor.orgId }),
    },
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
    kind: 'memory',
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
    async entries(query = {}): Promise<readonly AuditEntry[]> {
      const limit = auditLimit(SUBJECT, query);
      const before = query.before;
      // Insertion order reversed IS newest first, ties included: two entries of one millisecond
      // read in the order they were written, which an id drawn at random could not promise.
      const at = before === undefined ? -1 : log.findIndex((entry) => entry.id === before.id);
      const older =
        before === undefined
          ? log
          : at >= 0
            ? log.slice(0, at)
            : log.filter((entry) => newestFirst(before, entry) < 0);
      return older
        .filter(
          (entry) =>
            (query.entity === undefined || entry.entity === query.entity) &&
            (query.entityId === undefined || entry.entityId === query.entityId) &&
            (query.actorId === undefined || entry.actor.id === query.actorId) &&
            (query.orgId === undefined || entry.actor.orgId === query.orgId) &&
            (query.changes !== true || !isAllowedRead(entry)),
        )
        .reverse()
        .slice(0, limit);
    },
    atomic: (run) => run(),
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
