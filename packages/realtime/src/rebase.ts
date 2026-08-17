// Tier 3: the reconcile loop. The server rebases; the client rolls back and reapplies.
//
// Truth is always the server — a client is never the merge authority. So reconciliation is exactly:
// undo the optimistic writes from the acknowledged mutation onward (newest first), land server
// truth, then replay the still-pending mutators in sequence order. Because `local` is a pure
// function of `(tx, input)`, that replay is deterministic; that purity rule is the whole reason
// tier 3 is affordable.

import { RebaseConflictError } from './errors';
import type { Row } from './json';
import type { LocalStore, LocalTx, TableMap } from './local-store';
import { type ConflictStrategyName, type Frame, PROTOCOL_VERSION } from './sync-protocol';

export interface MergeArgs {
  /** Local row as the user last saw it, before any rollback. */
  readonly local: Row | undefined;
  /** Local row after the optimistic writes were undone — the shared base. */
  readonly base: Row | undefined;
  /** Server truth. `null` means the server deleted the row. */
  readonly server: Row | null;
}

export interface CustomMerge {
  readonly kind: 'custom';
  merge(args: MergeArgs): Row | null | undefined;
}

/** `conflict: custom(merge)` — exactly the name the mutator contract uses. */
export function custom(merge: (args: MergeArgs) => Row | null | undefined): CustomMerge {
  return { kind: 'custom', merge };
}

export type ConflictStrategy = 'server-wins' | 'last-write-wins' | CustomMerge;

export function strategyName(strategy: ConflictStrategy): ConflictStrategyName {
  return typeof strategy === 'string' ? strategy : 'custom';
}

export interface RebaseEntry<T extends TableMap = TableMap> {
  /** Idempotency key — the same key the offline queue uses. */
  readonly key: string;
  readonly seq: number;
  readonly entity: string;
  readonly strategy: ConflictStrategy;
  /** The mutator's `local` half, curried with its input. Pure, therefore replayable. */
  apply(tx: LocalTx<T>): void;
}

/** Optimistic writes awaiting server truth, ordered by client sequence. */
export class RebaseLog<T extends TableMap = TableMap> {
  readonly #entries = new Map<string, RebaseEntry<T>>();

  record(entry: RebaseEntry<T>): void {
    this.#entries.set(entry.key, entry);
  }

  get(key: string): RebaseEntry<T> | undefined {
    return this.#entries.get(key);
  }

  drop(key: string): void {
    this.#entries.delete(key);
  }

  pending(): readonly RebaseEntry<T>[] {
    return [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
  }

  get size(): number {
    return this.#entries.size;
  }
}

export interface ServerAck {
  readonly key: string;
  readonly entity: string;
  readonly id: string;
  readonly row: Row | null;
}

export interface ReconcileOptions {
  /** Field compared by `last-write-wins`. Must be a number (epoch ms) written by the server. */
  readonly clockField?: string;
}

export interface ReconcileResult {
  readonly strategy: ConflictStrategyName;
  readonly rolledBack: readonly string[];
  readonly reapplied: readonly string[];
  readonly winner: 'server' | 'local' | 'merge';
}

/**
 * One acknowledgement, one rebase. Rolls back the acked mutation and every later optimistic write,
 * lands server truth under the mutator's conflict strategy, then replays the rest in sequence order.
 */
export function reconcile<T extends TableMap = TableMap>(
  args: {
    store: LocalStore<T>;
    log: RebaseLog<T>;
    ack: ServerAck;
  },
  options: ReconcileOptions = {},
): ReconcileResult {
  const { store, log, ack } = args;
  const entry = log.get(ack.key);
  const strategy = entry?.strategy ?? 'server-wins';
  const table = store.table(ack.entity);
  const local = table.get(ack.id);

  const { affected, rolledBack } = undoFrom(store, log, entry?.seq ?? 0);

  const base = store.table(ack.entity).get(ack.id);
  const winner = land(store, ack, strategy, { local, base }, options);
  log.drop(ack.key);

  return {
    strategy: strategyName(strategy),
    rolledBack,
    reapplied: replayExcept(store, affected, ack.key),
    winner,
  };
}

/**
 * Everything at or after `from` is optimistic, so it is undone newest-first — and `reconcile` and
 * `rollbackMutation` are one rule with different middles, not two. Spelled twice, the next change
 * to the replay order has to be made twice, and the half that is missed diverges silently.
 */
function undoFrom<T extends TableMap>(
  store: LocalStore<T>,
  log: RebaseLog<T>,
  from: number,
): { affected: readonly RebaseEntry<T>[]; rolledBack: string[] } {
  const affected = log.pending().filter((candidate) => candidate.seq >= from);
  const rolledBack: string[] = [];
  for (const candidate of [...affected].reverse()) {
    store.rollback(candidate.key);
    rolledBack.push(candidate.key);
  }
  return { affected, rolledBack };
}

/**
 * The other half: replay in sequence order, skipping the one the server has now settled. `local` is
 * pure, which is what makes replaying it deterministic and therefore safe to do at all.
 */
function replayExcept<T extends TableMap>(
  store: LocalStore<T>,
  affected: readonly RebaseEntry<T>[],
  settled: string,
): string[] {
  const reapplied: string[] = [];
  for (const candidate of affected) {
    if (candidate.key === settled) continue;
    store.apply(candidate.key, (tx) => candidate.apply(tx));
    reapplied.push(candidate.key);
  }
  return reapplied;
}

export interface RollbackResult {
  readonly rolledBack: readonly string[];
  readonly reapplied: readonly string[];
}

/**
 * The other half of `reconcile`: the server **refused** a mutation, so there is no server truth to
 * land — only an optimistic write to take back. Same shape as a reconcile, and for the same reason:
 * the writes made after it may depend on it, so everything from its sequence onward is undone
 * newest-first and then replayed without it. Replay is deterministic because `local` is pure.
 *
 * Idempotent for a key the log does not hold: a denial can arrive twice, and tier 2 records nothing
 * to undo in the first place.
 */
export function rollbackMutation<T extends TableMap = TableMap>(args: {
  store: LocalStore<T>;
  log: RebaseLog<T>;
  key: string;
}): RollbackResult {
  const { store, log, key } = args;
  const entry = log.get(key);
  if (!entry) return { rolledBack: [], reapplied: [] };

  const { affected, rolledBack } = undoFrom(store, log, entry.seq);
  // The one thing that differs from `reconcile`'s middle: there is no server truth to land. Dropped
  // and never retried — a denial is a decision about this intent, so replaying it on the next
  // reconcile would put the write the server refused back on the screen.
  log.drop(key);
  return { rolledBack, reapplied: replayExcept(store, affected, key) };
}

function land<T extends TableMap>(
  store: LocalStore<T>,
  ack: ServerAck,
  strategy: ConflictStrategy,
  rows: { local: Row | undefined; base: Row | undefined },
  options: ReconcileOptions,
): 'server' | 'local' | 'merge' {
  const table = store.table(ack.entity);

  if (strategy === 'server-wins') {
    write(store, ack.entity, ack.id, ack.row);
    return 'server';
  }

  if (strategy === 'last-write-wins') {
    const field = options.clockField ?? 'updatedAt';
    const localAt = numberAt(rows.local, field);
    const serverAt = numberAt(ack.row, field);
    if (localAt !== null && serverAt !== null && localAt > serverAt) {
      // The local write is newer by the server's own clock field: keep it, do not clobber.
      if (rows.local) table.upsert(rows.local);
      return 'local';
    }
    write(store, ack.entity, ack.id, ack.row);
    return 'server';
  }

  const merged = strategy.merge({ local: rows.local, base: rows.base, server: ack.row });
  if (merged === undefined) {
    throw new RebaseConflictError({
      key: ack.key,
      entity: ack.entity,
      reason: 'custom(merge) returned undefined; return a row, or null to accept the delete',
    });
  }
  write(store, ack.entity, ack.id, merged);
  return 'merge';
}

function write<T extends TableMap>(
  store: LocalStore<T>,
  entity: string,
  id: string,
  row: Row | null,
): void {
  const table = store.table(entity);
  if (row === null) table.delete(id);
  else table.upsert(row);
}

function numberAt(row: Row | null | undefined, field: string): number | null {
  if (!row) return null;
  const value = row[field];
  return typeof value === 'number' ? value : null;
}

export function rebaseFrame(ack: ServerAck, strategy: ConflictStrategy): Frame {
  return {
    type: 'rebase',
    v: PROTOCOL_VERSION,
    key: ack.key,
    entity: ack.entity,
    strategy: strategyName(strategy),
    row: ack.row,
  };
}
