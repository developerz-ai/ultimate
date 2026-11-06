// From the oracle's red nodes to what an author pastes: the entity, and the `indexes: [{ on }]`
// entry by property. Pure. Also where a red node is argued away by the declaration itself: a
// lookup that pins a unique key reads one row whatever the planner walked to find it.

import type { PlanVerdict, PlanVerdictCode } from './plan-oracle';
import type { SeedEntity } from './seed-graph-shape';

export interface PlanFinding {
  readonly code: PlanVerdictCode;
  /** The statement as sent, whitespace collapsed, parameters still `$n`. */
  readonly statement: string;
  /** `Seq Scan`, `Index Scan`, `Sort`. */
  readonly node: string;
  readonly entity: string;
  readonly table: string;
  /** The `indexes: [{ on }]` entry, by property: tenant, equality, order, range. */
  readonly index: readonly string[];
}

/** Every column set the table holds unique: the primary key, unique columns, total unique rules. */
function uniqueKeys(entity: SeedEntity): readonly (readonly string[])[] {
  const description = entity.$describe();
  return [
    description.primaryKey,
    ...description.columns.filter((column) => column.unique).map((column) => [column.column]),
    ...description.indexes
      .filter((index) => index.unique && index.where === null)
      .map((index) => index.columns),
    ...description.invariants
      .filter((rule) => rule.kind === 'unique' && rule.where === null)
      .map((rule) => rule.columns),
  ].filter((key) => key.length > 0);
}

const IDENTIFIER = /"([A-Za-z_][\w$]*)"|\b([A-Za-z_][\w$]*)\b/g;

/**
 * A partial index the planner may use once it sees the bound value: its predicate compares only
 * columns the statement compares by equality (`where "state" = 'pending'` against `state = $1`),
 * and every column it holds is one the statement filters or orders by, the first among them. A
 * generic plan cannot match a predicate to a parameter, so the oracle sees a scan; Postgres plans
 * such a statement per value and keeps the index. Credited, never re-proven.
 */
function servedByPartial(entity: SeedEntity, verdict: PlanVerdict, order: readonly string[]) {
  const description = entity.$describe();
  const columns = new Set(description.columns.map((column) => column.column));
  const used = new Set([...verdict.equality, ...order, ...verdict.range]);
  return description.indexes.some((index) => {
    if (index.where === null) return false;
    const predicate = [...index.where.matchAll(IDENTIFIER)].flatMap(([, quoted, bare]) => {
      const name = quoted ?? bare;
      return name !== undefined && columns.has(name) ? [name] : [];
    });
    const lead = index.columns[0];
    return (
      predicate.length > 0 &&
      predicate.every((column) => verdict.equality.includes(column)) &&
      index.columns.every((column) => used.has(column)) &&
      lead !== undefined &&
      (verdict.equality.includes(lead) || order[0] === lead)
    );
  });
}

const ORDER_BY = /\border by\s+(.+?)(?:\s+limit\b|\s+offset\b|\s+for\b|$)/gi;

/**
 * The outermost `order by`'s columns, read off the text: an index walk avoids a sort and carries no
 * sort key of its own, yet the index that ends the walk has to hold the order too.
 */
function orderOf(statement: string, columns: ReadonlySet<string>): readonly string[] {
  const clauses = [...statement.matchAll(ORDER_BY)];
  const last = clauses[clauses.length - 1]?.[1] ?? '';
  return [...last.matchAll(IDENTIFIER)].flatMap(([, quoted, bare]) => {
    const name = quoted ?? bare;
    return name !== undefined && columns.has(name) ? [name] : [];
  });
}

/**
 * The findings one statement's verdicts make. A verdict whose equality columns pin a unique key is
 * dropped: one row at most. A table's sort verdict makes its scan verdict redundant — the index it
 * names leads with the same equality columns. The tenant column leads the index only when the
 * statement compares it: a read across tenants is served by no index that leads with one.
 */
export function planFindings(
  statement: string,
  verdicts: readonly PlanVerdict[],
  byTable: ReadonlyMap<string, SeedEntity>,
): readonly PlanFinding[] {
  const sorted = new Set(
    verdicts.filter((v) => v.code === 'X_QUERY_SORT_UNSERVED').map((v) => v.table),
  );
  return verdicts.flatMap((verdict): PlanFinding[] => {
    const entity = byTable.get(verdict.table);
    if (entity === undefined) return [];
    if (verdict.code === 'X_QUERY_UNINDEXED' && sorted.has(verdict.table)) return [];
    const pinned = uniqueKeys(entity).some((key) =>
      key.every((column) => verdict.equality.includes(column)),
    );
    if (pinned) return [];
    const description = entity.$describe();
    const byColumn = new Map(description.columns.map((c) => [c.column, c.property]));
    const walked = verdict.code === 'X_QUERY_UNINDEXED' && verdict.node !== 'Seq Scan';
    const order = walked
      ? orderOf(statement, new Set(description.columns.map((c) => c.column)))
      : verdict.order;
    if (servedByPartial(entity, verdict, order)) return [];
    const tenant = description.columns.find((c) => c.property === entity.$tenantColumn)?.column;
    const lead = tenant !== undefined && verdict.equality.includes(tenant) ? [tenant] : [];
    const columns = [...new Set([...lead, ...verdict.equality, ...order, ...verdict.range])];
    return [
      {
        code: verdict.code,
        statement,
        node: verdict.node,
        entity: entity.$name,
        table: verdict.table,
        index: columns.flatMap((column) => byColumn.get(column) ?? []),
      },
    ];
  });
}
