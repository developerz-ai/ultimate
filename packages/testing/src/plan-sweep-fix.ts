// From the oracle's red nodes to what an author pastes: the entity, and the `indexes: [{ on }]`
// entry by property. Pure. Also where a red node is argued away by the declaration itself: a
// lookup that pins a unique key reads one row whatever the planner walked to find it, and a whole
// read a keyed join side could probe by a declared index is one the planner declined on cost.

import type { PlanVerdict, PlanVerdictCode } from './plan-oracle';
import type { PlanUnservable } from './plan-sort-key';
import { sortKeyPart } from './plan-sort-key';
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
  /**
   * Why no index is the fix: a sort no declarable index serves, or `declared` — the index the node
   * asks for is one the entity already holds, so declaring it again changes no plan. `index` is
   * empty with it.
   */
  readonly unserved?: PlanUnservable | 'declared';
}

/** Every column set the table holds unique: the primary key, unique columns, total unique rules. */
function uniqueKeys(entity: SeedEntity, statement: string): readonly (readonly string[])[] {
  const description = entity.$describe();
  const holds = (where: string | null): boolean => where === null || stated(where, statement);
  return [
    description.primaryKey,
    ...description.columns.filter((column) => column.unique).map((column) => [column.column]),
    ...description.indexes
      .filter((index) => index.unique && holds(index.where))
      .map((index) => index.columns),
    ...description.invariants
      .filter((rule) => rule.kind === 'unique' && holds(rule.where))
      .map((rule) => rule.columns),
  ].filter((key) => key.length > 0);
}

/** Lower case outside literals, no identifier quotes, no parentheses, single spaces. */
const normalized = (sql: string): string =>
  sql
    .split(/('[^']*')/)
    .map((part, at) => (at % 2 === 1 ? part : part.toLowerCase().replace(/["()]/g, ' ')))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A partial rule holds for a statement that states its predicate, conjunct for conjunct:
 * `deleted_at is null` is in every soft-deleted entity's `one()`. Text, so a predicate the
 * statement implies some other way is not credited — a finding, never a false pass.
 */
function stated(where: string, statement: string): boolean {
  const text = ` ${normalized(statement)} `;
  return normalized(where)
    .split(/\band\b/)
    .every((conjunct) => text.includes(` ${conjunct.trim()} `));
}

/** Every non-partial index the entity declares, in column order: primary key and unique ones too. */
function declaredIndexes(entity: SeedEntity, statement: string): readonly (readonly string[])[] {
  const description = entity.$describe();
  return [
    ...uniqueKeys(entity, statement),
    ...description.indexes.filter((index) => index.where === null).map((index) => index.columns),
  ];
}

/**
 * A walk filtered by a range is served by an index that leads with the equality columns and then
 * a range column: it bounds the rows and the planner sorts the few left. A generic plan with sorts
 * off still prefers the ordered walk, so the oracle cannot see it. Credited, never re-proven.
 */
const servedByRange = (keys: readonly (readonly string[])[], verdict: PlanVerdict): boolean =>
  keys.some((key) => {
    const next = key[verdict.equality.length];
    return (
      next !== undefined &&
      verdict.range.includes(next) &&
      key.slice(0, verdict.equality.length).every((column) => verdict.equality.includes(column))
    );
  });

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

/** `a, f(b, c), d` → its three items: commas outside parentheses only. */
function items(list: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < list.length; at += 1) {
    if (list[at] === '(') depth += 1;
    else if (list[at] === ')') depth -= 1;
    else if (list[at] === ',' && depth === 0) {
      found.push(list.slice(start, at));
      start = at + 1;
    }
  }
  return [...found, list.slice(start)];
}

/**
 * The outermost `order by`'s leading columns of the walked table, read off the text: an index walk
 * avoids a sort and carries no sort key of its own, yet the index that ends the walk has to hold
 * the order too. Only as far as one index can: plain columns of this table, one direction — past
 * them the rows arrive presorted and Postgres finishes with an incremental sort.
 */
function orderOf(statement: string, columns: ReadonlySet<string>, verdict: PlanVerdict) {
  const clauses = [...statement.matchAll(ORDER_BY)];
  const order: string[] = [];
  let way: string | undefined;
  for (const item of items(clauses[clauses.length - 1]?.[1] ?? '')) {
    const part = sortKeyPart(item);
    const own =
      part.column !== undefined &&
      columns.has(part.column.name) &&
      [undefined, verdict.table, verdict.alias].includes(part.column.qualifier);
    if (!own || part.way === 'mixed' || (way !== undefined && part.way !== way)) break;
    way = part.way;
    if (part.column !== undefined) order.push(part.column.name);
  }
  return order;
}

/**
 * An OR the read is bounded by and nothing else: one index per arm answers it, as a BitmapOr. An
 * arm whose column leads a declared index is answered already — the sweep's settings discourage
 * the BitmapOr, so the plan alone cannot say; credited, never re-proven.
 */
function armFindings(
  verdict: PlanVerdict,
  declared: readonly (readonly string[])[],
  property: (column: string) => string | undefined,
): readonly (readonly string[])[] {
  const arms = new Map((verdict.arms ?? []).map((arm) => [arm.join('\u0000'), arm]));
  return [...arms.values()]
    .filter((arm) => !declared.some((key) => key[0] !== undefined && arm.includes(key[0])))
    .map((arm) => arm.flatMap((column) => property(column) ?? []));
}

/**
 * A whole read a keyed side could probe: a column it is joined by leads a declared index. On empty
 * tables the planner may walk a small-looking index (a partial one the statement implies) rather
 * than probe it per row; at size it probes. Credited, never re-proven, as a range index is.
 */
const probed = (keys: readonly (readonly string[])[], verdict: PlanVerdict): boolean =>
  verdict.code === 'X_QUERY_UNINDEXED' &&
  (verdict.probes ?? []).some((column) => keys.some((key) => key[0] === column));

/**
 * The plan was taken with every declared index in place: one that leads with exactly these
 * columns is already there, and printing it as the fix would change nothing.
 */
const held = (keys: readonly (readonly string[])[], columns: readonly string[]): boolean =>
  columns.length > 0 && keys.some((key) => columns.every((column, at) => key[at] === column));

/**
 * The findings one statement's verdicts make. A verdict whose equality columns pin a unique key is
 * dropped: one row at most. A table's sort verdict makes its scan verdict redundant — the index it
 * names leads with the same equality columns. The tenant column leads the index only when the
 * statement compares it: a read across tenants is served by no index that leads with one. A sort
 * no declarable index serves, or an index the entity already holds, is red with no index to paste.
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
    const pinned = uniqueKeys(entity, statement).some((key) =>
      key.every((column) => verdict.equality.includes(column)),
    );
    if (pinned) return [];
    const finding = {
      code: verdict.code,
      statement,
      node: verdict.node,
      entity: entity.$name,
      table: verdict.table,
    };
    if (verdict.unservable !== undefined) {
      return [{ ...finding, index: [], unserved: verdict.unservable }];
    }
    const description = entity.$describe();
    const byColumn = new Map(description.columns.map((c) => [c.column, c.property]));
    const walked = verdict.code === 'X_QUERY_UNINDEXED' && verdict.node !== 'Seq Scan';
    // A walk filtered by a range already has its order: what it lacks is the bound. A btree serves
    // no order after a range column, so the index is the equality columns, then the range.
    const ranged = walked && verdict.range.length > 0;
    const declared = declaredIndexes(entity, statement);
    if (probed(declared, verdict)) return [];
    const bounded = verdict.equality.length > 0 || verdict.range.length > 0;
    if (!bounded && verdict.arms !== undefined && verdict.code === 'X_QUERY_UNINDEXED') {
      const arms = armFindings(verdict, declared, (column) => byColumn.get(column));
      return arms.map((index) => ({ ...finding, index }));
    }
    if (ranged && servedByRange(declared, verdict)) return [];
    const order = ranged
      ? []
      : walked
        ? orderOf(statement, new Set(description.columns.map((c) => c.column)), verdict)
        : verdict.order;
    if (servedByPartial(entity, verdict, order)) return [];
    const tenant = description.columns.find((c) => c.property === entity.$tenantColumn)?.column;
    const lead = tenant !== undefined && verdict.equality.includes(tenant) ? [tenant] : [];
    const columns = [...new Set([...lead, ...verdict.equality, ...order, ...verdict.range])];
    if (held(declared, columns)) return [{ ...finding, index: [], unserved: 'declared' }];
    return [{ ...finding, index: columns.flatMap((column) => byColumn.get(column) ?? []) }];
  });
}
