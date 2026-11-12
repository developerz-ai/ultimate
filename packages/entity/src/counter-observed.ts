// Single responsibility: the parent change a `countedIn` counter makes, reported. The trigger (and
// the memory driver's mirror, `memory-lifecycle.ts`) rewrites the parent row inside the child's
// write, where no repository sees it — so a live query over `posts` never heard a like. This reads
// the rewritten parents back, only while `entity.row` has a subscriber, and reports them.

import { currentWriteOrigin, instrument, subscribed } from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import { type Counter, countersTargeting } from './counter';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { MAX_PAGE_SIZE } from './plan';
import type { FilteredWriteOptions, Repo, RepoOptions } from './repo';
import { sealedFields } from './sealed';
import { afterCommit } from './write-commit';

/** How `database()` hands the observer a parent's repository: the driver's own, unwrapped. */
export type RepoOf = (entity: EntityCore) => Repo<unknown>;

type Row = Readonly<Record<string, unknown>>;

/** One parent a write moved: by how much (`null`: a filter's write, unknown), in which tenant. */
interface Moved {
  readonly delta: number | null;
  readonly tenant: string | undefined;
}

const ROW = 'entity.row';
const BULK = 'entity.bulk';

const asRow = (value: unknown): Row | null =>
  typeof value === 'object' && value !== null ? (value as Row) : null;

/** The parent a child row counts into, or `undefined` when it counts nowhere (deleted, no key). */
const countedParent = (counter: Counter, row: unknown): string | undefined => {
  const record = asRow(row);
  if (record === null) return undefined;
  if (counter.child.$softDelete && record[SOFT_DELETE_COLUMN] != null) return undefined;
  const id = record[counter.references];
  return typeof id === 'string' ? id : undefined;
};

/**
 * The one value a filtered write pins `property` to: the filter's own, else a chain's `eq` predicate
 * (`where({ postId }).deleteAll()` names its filter as predicates, not as the equality map).
 */
const pinnedTo = (
  filter: Row | null,
  options: FilteredWriteOptions | undefined,
  property: string,
): unknown =>
  filter?.[property] ??
  options?.where?.find((each) => each.column === property && each.op === 'eq')?.value;

/** Whether a patch can move a counter: it sets the key, or the soft-delete stamp. */
const moves = (counter: Counter, patch: Row): boolean =>
  counter.references in patch || (counter.child.$softDelete && SOFT_DELETE_COLUMN in patch);

export interface CounterEcho {
  /** Row writes: each change as `[before, after]`, `null` on the side that did not exist. */
  rows(changes: readonly (readonly [unknown, unknown])[], options?: RepoOptions): Promise<void>;
  /** A filtered write (`deleteWhere`, `updateWhere`, `updateMany`) that changed `rows` rows. */
  filtered(
    filter: Row | null,
    patch: Row | null,
    rows: number,
    options?: FilteredWriteOptions,
  ): Promise<void>;
}

/** The echo for one child entity. `undefined` without a parent repository to read back from. */
export function counterEcho(
  child: EntityCore,
  repoOf: RepoOf | undefined,
): CounterEcho | undefined {
  if (repoOf === undefined) return undefined;

  const bulk = (parent: EntityCore, rows: number, options: RepoOptions | undefined): void => {
    if (rows > 0 && subscribed(BULK)) {
      afterCommit(options, () => instrument(BULK, { entity: parent.$name, op: 'update', rows }));
    }
  };

  /**
   * Read the parents back in the write's own transaction, one statement per tenant and page of ids,
   * and report each. `delta` known: `before` is the row with the count moved back; unknown: `null`,
   * which is what replication reports without `REPLICA IDENTITY FULL` — wider, never wrong. The
   * tenant is the write's, else the child row's own (a counter's parent shares its child's tenant).
   * A refused read still reports, as a count a subscriber re-reads on.
   */
  const report = async (
    counter: Counter,
    moved: ReadonlyMap<string, Moved>,
    options: RepoOptions | undefined,
  ): Promise<void> => {
    const { parent } = counter;
    if (moved.size === 0) return;
    const key = parent.$primaryKey[0] ?? 'id';
    const byTenant = new Map<string | undefined, string[]>();
    for (const [id, { tenant }] of moved) {
      const scope = parent.$tenantColumn === null ? undefined : (options?.orgId ?? tenant);
      byTenant.set(scope, [...(byTenant.get(scope) ?? []), id]);
    }
    const read = new Map<string, Row>();
    try {
      for (const [orgId, ids] of byTenant) {
        for (let at = 0; at < ids.length; at += MAX_PAGE_SIZE) {
          const chunk = ids.slice(at, at + MAX_PAGE_SIZE);
          const page = await expectedQueryLoop(
            'the entity.row event reads back the parents a countedIn trigger moved — one per write',
            () =>
              repoOf(parent).findMany({
                where: [{ column: key, op: 'in', value: chunk }],
                limit: chunk.length,
                ...(options?.tx === undefined ? {} : { tx: options.tx }),
                ...(orgId === undefined ? {} : { orgId }),
              }),
          );
          for (const row of page.rows) {
            const record = asRow(row);
            if (record !== null) read.set(String(record[key]), record);
          }
        }
      }
    } catch {
      bulk(parent, moved.size, options);
      return;
    }
    const sealed = sealedFields(parent).map((field) => field.property);
    const shown = (row: Row): Row =>
      Object.fromEntries(Object.entries(row).filter(([property]) => !sealed.includes(property)));
    const write = currentWriteOrigin();
    for (const [id, { delta }] of moved) {
      const after = read.get(id);
      if (after === undefined) continue;
      const before =
        delta === null
          ? null
          : { ...after, [counter.column]: Number(after[counter.column]) - delta };
      const change = {
        entity: parent.$name,
        op: 'update' as const,
        before: before === null ? null : shown(before),
        after: shown(after),
        ...(write === undefined ? {} : { write }),
      };
      afterCommit(options, () => instrument(ROW, change));
    }
  };

  /** The child row's tenant, which a counted parent shares. */
  const tenantOf = (row: unknown): string | undefined => {
    const column = child.$tenantColumn;
    const value = column === null ? undefined : asRow(row)?.[column];
    return typeof value === 'string' ? value : undefined;
  };

  return {
    async rows(changes, options) {
      if (!subscribed(ROW)) return;
      for (const counter of countersTargeting(child.$name)) {
        const moved = new Map<string, Moved>();
        const move = (row: unknown, by: number): void => {
          const id = countedParent(counter, row);
          if (id === undefined) return;
          const delta = (moved.get(id)?.delta ?? 0) + by;
          moved.set(id, { delta, tenant: tenantOf(row) });
        };
        for (const [before, after] of changes) {
          move(before, -1);
          move(after, 1);
        }
        for (const [id, { delta }] of moved) if (delta === 0) moved.delete(id);
        await report(counter, moved, options);
      }
    },

    async filtered(filter, patch, rows, options) {
      if (rows === 0 || !(subscribed(ROW) || subscribed(BULK))) return;
      for (const counter of countersTargeting(child.$name)) {
        if (patch !== null && !moves(counter, patch)) continue;
        const from = pinnedTo(filter, options, counter.references);
        const to = patch === null ? undefined : patch[counter.references];
        // Pinned: the filter names one parent, and the patch names one or keeps it — so the
        // parents that moved are known, though not by how much.
        const pinned =
          typeof from === 'string' && (to === undefined || to === null || typeof to === 'string');
        if (!pinned || !subscribed(ROW)) {
          bulk(counter.parent, rows, options);
          continue;
        }
        const scope = child.$tenantColumn;
        const pinnedTenant = scope === null ? undefined : pinnedTo(filter, options, scope);
        const tenant = typeof pinnedTenant === 'string' ? pinnedTenant : undefined;
        const moved = new Map<string, Moved>([[from, { delta: null, tenant }]]);
        if (typeof to === 'string') moved.set(to, { delta: null, tenant });
        await report(counter, moved, options);
      }
    },
  };
}
