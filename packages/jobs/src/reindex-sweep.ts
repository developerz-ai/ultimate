// `reindex()`'s second phase: the documents an index holds whose row the source no longer reads —
// deleted while the index was down, deleted by a store that names no rows, or moved to another
// tenant. One `list` page at a time, each looked up by its key, the absent ones removed.

import type { Ctx } from '@ultimat3/core';
import type { EntityCore, ReadBuilder, SearchIndex, SearchListEntry } from '@ultimat3/entity';
// The barrel's leaves, never `@ultimat3/entity/adapter`: that drags the driver kit into ROLE=migrate.
import { kindOf, MAX_PAGE_SIZE, rowKey } from '@ultimat3/entity';

/** A row's place in the index: its tenant and its key, as one comparable string. */
const placeOf = (tenant: string | null, id: string): string => JSON.stringify([tenant, id]);

/** The key values an index id spells (`rowKey`): one, or a composite key's JSON array of them. */
const keyValues = (entity: EntityCore<unknown>, id: string): readonly string[] => {
  if (entity.$primaryKey.length === 1) return [id];
  try {
    const parsed: unknown = JSON.parse(id);
    return Array.isArray(parsed) && parsed.every((each) => typeof each === 'string') ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * A key spelling as the column compares it: `rowKey` writes an `integer` by value and an instant
 * in ISO, both as text — handed back as the number and the `Date` the column holds.
 */
const typed = (entity: EntityCore<unknown>, property: string, spelled: string): unknown => {
  const kind = kindOf(entity, property);
  if (kind === 'integer') return Number(spelled);
  if (kind === 'timestamptz') return new Date(spelled);
  return spelled;
};

/**
 * The places among `entries` the source still reads. One read per page: each key column `in` the
 * values the page names — exact for a single key, a superset for a composite one, matched here.
 */
const present = async <Row>(
  entity: EntityCore<Row>,
  source: ReadBuilder<Row>,
  entries: readonly SearchListEntry[],
): Promise<ReadonlySet<string>> => {
  const core = entity as EntityCore<unknown>;
  let chain = source;
  for (const [position, property] of core.$primaryKey.entries()) {
    const values = new Set(entries.flatMap((entry) => keyValues(core, entry.id)[position] ?? []));
    if (values.size === 0) return new Set();
    chain = chain.andWhere(
      property as keyof Row & string,
      'in',
      [...values].map((value) => typed(core, property, value)),
    );
  }
  const tenantColumn = core.$tenantColumn;
  const found = new Set<string>();
  for await (const batch of chain.inBatches(MAX_PAGE_SIZE)) {
    for (const row of batch) {
      const tenant =
        tenantColumn === null ? null : (row as Readonly<Record<string, unknown>>)[tenantColumn];
      found.add(placeOf(typeof tenant === 'string' ? tenant : null, rowKey(core, row)));
    }
  }
  return found;
};

/**
 * Remove every entry of one `list` page whose row the source no longer reads. The tombstone sits
 * ONE millisecond above the version listed, never at the sweep's own instant: a write that put the
 * id back after the list is newer than that, and keeps its document.
 */
export const sweepListed = async <Row>(args: {
  readonly entity: EntityCore<Row>;
  readonly source: (args: { readonly ctx: Ctx }) => ReadBuilder<Row>;
  readonly ctx: Ctx;
  readonly index: SearchIndex;
  readonly entries: readonly SearchListEntry[];
}): Promise<number> => {
  const { entity, entries, index } = args;
  if (entries.length === 0) return 0;
  const still = await present(entity, args.source({ ctx: args.ctx }), entries);
  const gone = new Map<string, { tenant: string | null; version: number; ids: string[] }>();
  for (const entry of entries) {
    if (still.has(placeOf(entry.tenant, entry.id))) continue;
    const at = JSON.stringify([entry.tenant, entry.version]);
    const group = gone.get(at) ?? { tenant: entry.tenant, version: entry.version, ids: [] };
    group.ids.push(entry.id);
    gone.set(at, group);
  }
  for (const { tenant, version, ids } of gone.values()) {
    await index.remove({ entity: entity.$name, tenant }, ids, version + 1);
  }
  return [...gone.values()].reduce((sum, group) => sum + group.ids.length, 0);
};
