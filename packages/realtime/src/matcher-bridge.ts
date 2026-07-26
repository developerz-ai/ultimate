// One `ChangeEvent` -> the minimal patches for one subscription, via `@ultimat3/query`'s matcher.
//
// The pre-filter is the load-bearing part. Fanout is affordable only because a change that cannot
// touch a subscription costs three comparisons (entity, tenant, column set) and never reaches the
// matcher. A change touching no registered query costs one predicate check in total.

import { type LiveQuery, match, type Patch } from '@ultimat3/query';
import type { ChangeEvent } from './changefeed';
import { changedColumns, isJsonObject, type JsonObject, type Row, type RowPatch } from './json';

export interface SubscriptionShape {
  readonly qid: string;
  /** Dependency set: the entities and tags this query reads (`LiveQuery.reads`). */
  readonly entities: readonly string[];
  /** Tenant scope. A change in another tenant is dropped before any predicate runs. */
  readonly orgId: string | null;
  /** Read set. An update touching none of these columns cannot change the result. */
  readonly columns?: readonly string[];
}

export interface BridgeResult {
  readonly patches: readonly RowPatch[];
  /**
   * The window lost a row and the tail is unknown: the subscriber must re-read rather than guess.
   * Handled as a re-snapshot, which is exactly the fallback the reconnect budget already pays for.
   */
  readonly refill: boolean;
}

export const NO_CHANGE: BridgeResult = { patches: [], refill: false };

export interface IncrementalMatcher {
  readonly entities: readonly string[];
  /** `rows` is the query's current *pre-policy* window, shared by every subscriber of the qid. */
  match(change: ChangeEvent, rows: readonly Row[]): BridgeResult;
}

/** The cheap pre-filter. Pure, and the only thing that runs for a change nobody subscribed to. */
export function canAffect(shape: SubscriptionShape, change: ChangeEvent): boolean {
  if (!shape.entities.includes(change.entity)) return false;
  if (shape.orgId !== null && change.orgId !== null && shape.orgId !== change.orgId) return false;
  if (shape.columns && change.op === 'update' && change.after !== null) {
    const touched = Object.keys(changedColumns(change.before, change.after));
    if (touched.length > 0 && !touched.some((column) => shape.columns?.includes(column)))
      return false;
  }
  return true;
}

/** Pre-filter, then match. Returns `null` for "skip this subscription" — the common case. */
export function bridgeChange(
  shape: SubscriptionShape,
  incremental: IncrementalMatcher,
  change: ChangeEvent,
  rows: readonly Row[],
): BridgeResult | null {
  if (!canAffect(shape, change)) return null;
  const result = incremental.match(change, rows);
  return result.patches.length === 0 && !result.refill ? null : result;
}

/** Default derivation, used by matchers that only answer "affected" without describing the delta. */
export function patchFromChange(change: ChangeEvent): RowPatch | null {
  if (change.op === 'delete') {
    const id = change.before?.id;
    return id === undefined ? null : { op: 'delete', id, row: null, lsn: change.lsn };
  }
  const after = change.after;
  if (after === null) return null;
  const row: JsonObject =
    change.op === 'insert' ? after : { id: after.id, ...changedColumns(change.before, after) };
  return { op: change.op === 'insert' ? 'insert' : 'update', id: after.id, row, lsn: change.lsn };
}

/**
 * The seam to `@ultimat3/query`. Everything else in this package talks to `IncrementalMatcher`, so
 * swapping the matcher — or adopting an external protocol's, per the risk register — touches this
 * function only.
 */
export function matcherFor(live: LiveQuery): IncrementalMatcher {
  return {
    entities: live.reads,
    match: (change, rows) => {
      const row = change.after ?? change.before;
      if (!row) return NO_CHANGE;
      const patches = match<Row>(live.name, live.shape, rows, {
        entity: change.entity,
        op: change.op,
        row,
        ...(change.before === null ? {} : { before: change.before }),
      });
      return toBridgeResult(patches, change);
    },
  };
}

/** `Patch<Row>` (add/update/remove/refill, positional) -> the wire's `RowPatch`. */
export function toBridgeResult(patches: readonly Patch<Row>[], change: ChangeEvent): BridgeResult {
  const out: RowPatch[] = [];
  let refill = false;
  for (const patch of patches) {
    switch (patch.kind) {
      case 'add':
        out.push({
          op: 'insert',
          id: patch.row.id,
          row: patch.row,
          lsn: change.lsn,
          index: patch.position,
        });
        break;
      case 'update':
        out.push({
          op: 'update',
          id: patch.row.id,
          row: { id: patch.row.id, ...changedColumns(change.before, patch.row) },
          lsn: change.lsn,
          index: patch.position,
        });
        break;
      case 'remove':
        out.push({ op: 'delete', id: patch.id, row: null, lsn: change.lsn, index: patch.position });
        break;
      case 'refill':
        refill = true;
        break;
    }
  }
  return { patches: out, refill };
}

/** Applies patches to the shared pre-policy window so the matcher sees the current result set. */
export function applyToWindow(rows: readonly Row[], patches: readonly RowPatch[]): Row[] {
  const next = [...rows];
  for (const patch of patches) {
    const index = next.findIndex((row) => row.id === patch.id);
    if (patch.op === 'delete') {
      if (index >= 0) next.splice(index, 1);
      continue;
    }
    if (patch.row === null) continue;
    const current = index >= 0 ? next[index] : undefined;
    const merged: Row = { ...(current ?? {}), ...patch.row, id: patch.id };
    if (index >= 0) next[index] = merged;
    else if (patch.index !== undefined) next.splice(patch.index, 0, merged);
    else next.push(merged);
  }
  return next;
}

/** Accepts a foreign matcher's patch shape and lands it on the wire shape. Defensive by design. */
export function normalizePatch(candidate: unknown, change: ChangeEvent): RowPatch | null {
  if (candidate === null || candidate === undefined || candidate === false) return null;
  if (candidate === true) return patchFromChange(change);
  if (!isJsonObject(candidate)) return null;
  const op = candidate['op'];
  if (op !== 'insert' && op !== 'update' && op !== 'delete') return patchFromChange(change);
  const id = candidate['id'];
  const rowValue = candidate['row'];
  const index = candidate['index'];
  const base: RowPatch = {
    op,
    id: typeof id === 'string' ? id : (change.after?.id ?? change.before?.id ?? ''),
    row: op === 'delete' ? null : isJsonObject(rowValue) ? rowValue : (change.after ?? null),
    lsn: typeof candidate['lsn'] === 'string' ? candidate['lsn'] : change.lsn,
  };
  if (base.id === '') return null;
  return typeof index === 'number' ? { ...base, index } : base;
}
