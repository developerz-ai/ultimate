// The plan oracle: one `explain (format json)` plan, taken with sequential scans, bitmap scans and
// sorts disabled, in; the nodes no index could replace, out. Under those settings the planner picks
// a scan or a sort only when nothing else answers, so the verdict reads the schema, not the rows.
// Pure: JSON in, verdicts out (plan 101, 40-next-query-plans).

import { columnsIn } from './plan-conditions';
import type { ProbeScan } from './plan-probes';
import { probesOf } from './plan-probes';
import type { PlanUnservable, SortKeyRef } from './plan-sort-key';
import { sortKeyPart, sortUnservable } from './plan-sort-key';

/** What a red node is: a whole-table read, or rows sorted for a limited read. */
export type PlanVerdictCode = 'X_QUERY_UNINDEXED' | 'X_QUERY_SORT_UNSERVED';

export interface PlanVerdict {
  readonly code: PlanVerdictCode;
  /** `Seq Scan`, `Index Scan`, `Index Only Scan`, `Sort`. */
  readonly node: string;
  /** The physical table the node reads, or the one under the sort. */
  readonly table: string;
  /** Physical columns the statement compares by equality on that table, in the order seen. */
  readonly equality: readonly string[];
  /** Physical columns it compares any other way (a range, a pattern). */
  readonly range: readonly string[];
  /** The sort's columns on that table, in order. Empty for a scan, or a sort no index serves. */
  readonly order: readonly string[];
  /** A sort no declarable index serves: why (`plan-sort-key.ts`). */
  readonly unservable?: PlanUnservable;
  /** The arms of an OR the read is bounded by, each its columns: one index answers each arm. */
  readonly arms?: readonly (readonly string[])[];
  /** The alias the plan reads the table by, when it is not the table's own name. */
  readonly alias?: string;
  /**
   * Columns a join ties this whole read to a scan bound by its own key (`plan-probes.ts`): one
   * that leads an index is a probe the planner had and declined on an empty table's costs.
   */
  readonly probes?: readonly string[];
}

interface PlanNode {
  readonly type: string;
  readonly table: string | undefined;
  readonly alias: string | undefined;
  readonly conditions: readonly string[];
  readonly sortKey: readonly string[];
  readonly indexCond: string | undefined;
  readonly filter: boolean;
  readonly children: readonly PlanNode[];
}

const SCANS: ReadonlySet<string> = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan']);
/** Nodes that hold their child's rows for a join: the join's conditions are the child's still. */
const HOLDS: ReadonlySet<string> = new Set(['Hash', 'Materialize', 'Memoize']);
/** Conditions a join or a recheck carries for the scans beneath it. */
const CONDITION_KEYS = ['Index Cond', 'Filter', 'Hash Cond', 'Merge Cond', 'Join Filter'] as const;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function nodeOf(value: unknown): PlanNode | undefined {
  const raw = record(value);
  const type = text(raw?.['Node Type']);
  if (raw === undefined || type === undefined) return undefined;
  const plans = Array.isArray(raw['Plans']) ? raw['Plans'] : [];
  const sortKey = Array.isArray(raw['Sort Key'])
    ? raw['Sort Key'].flatMap((k) => text(k) ?? [])
    : [];
  return {
    type,
    table: text(raw['Relation Name']),
    alias: text(raw['Alias']),
    conditions: CONDITION_KEYS.flatMap((key) => text(raw[key]) ?? []),
    sortKey,
    indexCond: text(raw['Index Cond']),
    filter: text(raw['Filter']) !== undefined,
    children: plans.flatMap((child) => nodeOf(child) ?? []),
  };
}

/** The root node of `explain (format json)`'s answer: `[{ "Plan": { … } }]`, or the bare plan. */
export function planRoot(answer: unknown): unknown {
  const parsed = typeof answer === 'string' ? (JSON.parse(answer) as unknown) : answer;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return record(first)?.['Plan'] ?? first;
}

/** Every scan beneath `node` (the node itself included), of any table. */
const scansBeneath = (node: PlanNode): readonly PlanNode[] => [
  ...(node.table !== undefined && SCANS.has(node.type) ? [node] : []),
  ...node.children.flatMap(scansBeneath),
];

/** Nodes that compute what is sorted: past one, the sort key is no table's stored order. */
const COMPUTED: ReadonlySet<string> = new Set(['Aggregate', 'WindowAgg', 'Group']);
const computedBeneath = (node: PlanNode): boolean =>
  node.children.some((child) => COMPUTED.has(child.type) || computedBeneath(child));

/**
 * The verdict of a `Sort` under a `Limit`. It belongs to the table its key names — a join lists
 * its other side first, and that side's columns are not what is sorted. A key no index can hold
 * still names a table, with no order to index; a key on a table the sweep does not judge (a
 * declared `scan:`, a framework table) is that table's, and no verdict.
 */
function sortVerdict(
  node: PlanNode,
  conditions: readonly string[],
  tables: PlanTableColumns,
): PlanVerdict | undefined {
  const scans = scansBeneath(node);
  const judged = scans.filter((scan) => scan.table !== undefined && tables.has(scan.table));
  const scanOf = (ref: SortKeyRef): PlanNode | undefined =>
    scans.find((scan) =>
      ref.qualifier === undefined
        ? scan.table !== undefined && tables.get(scan.table)?.has(ref.name) === true
        : ref.qualifier === scan.alias || ref.qualifier === scan.table,
    );
  const parts = node.sortKey.map(sortKeyPart);
  const owners = parts.flatMap((part) => part.refs).flatMap((ref) => scanOf(ref) ?? []);
  const owner = owners[0];
  if (owner?.table !== undefined && !tables.has(owner.table)) return undefined;
  const scan = owner ?? judged[0];
  const columns = scan?.table === undefined ? undefined : tables.get(scan.table);
  if (scan?.table === undefined || columns === undefined) return undefined;
  const plainUnowned = parts.some((part) => part.column && scanOf(part.column) === undefined);
  const unservable: PlanUnservable | undefined =
    parts.some((part) => part.column === undefined) && computedBeneath(node)
      ? 'aggregate'
      : plainUnowned
        ? 'derived'
        : sortUnservable(parts, (ref) => scanOf(ref)?.table);
  const found = columnsIn([...conditions, ...scan.conditions], scan, columns);
  const order = columnsIn(node.sortKey, scan, columns);
  return {
    code: 'X_QUERY_SORT_UNSERVED',
    node: node.type,
    table: scan.table,
    equality: found.equality,
    range: [],
    order: unservable === undefined ? [...order.equality, ...order.range] : [],
    ...(unservable === undefined ? {} : { unservable }),
  };
}

/** Physical table → its physical columns: only these tables are judged. */
export type PlanTableColumns = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Every red node of one plan. `Seq Scan` on a judged table; an index scan with no `Index Cond`,
 * unless a `Limit` above it stops it early and no `Filter` makes it walk on; a `Sort` under a
 * `Limit`. A join's conditions are handed down, through the nodes that only hold rows for it, so
 * the scan of its inner side names its key — and a whole read tied to a keyed side, its probe.
 */
export function judgePlan(answer: unknown, tables: PlanTableColumns): readonly PlanVerdict[] {
  const root = nodeOf(planRoot(answer));
  if (root === undefined) return [];
  const verdicts: PlanVerdict[] = [];
  const scans: (ProbeScan & { readonly verdict: number | undefined })[] = [];
  const walk = (node: PlanNode, limited: boolean, inherited: readonly string[]): void => {
    const conditions = [...inherited, ...node.conditions];
    const columns = node.table === undefined ? undefined : tables.get(node.table);
    if (node.table !== undefined && SCANS.has(node.type)) {
      const judged = columns !== undefined;
      const unbounded =
        node.type === 'Seq Scan' || (node.indexCond === undefined && (!limited || node.filter));
      if (judged && unbounded) {
        const found = columnsIn(conditions, node, columns);
        verdicts.push({
          code: 'X_QUERY_UNINDEXED',
          node: node.type,
          table: node.table,
          ...found,
          order: [],
          ...(node.alias === undefined || node.alias === node.table ? {} : { alias: node.alias }),
        });
      }
      const { table, alias, indexCond } = node;
      const verdict = judged && unbounded ? verdicts.length - 1 : undefined;
      scans.push({ table, alias, indexCond, conditions, verdict });
    }
    if (node.type === 'Sort' && limited) {
      const sorted = sortVerdict(node, conditions, tables);
      if (sorted !== undefined) verdicts.push(sorted);
    }
    const below = limited || node.type === 'Limit';
    // A join's conditions name both sides: each child keeps only the conjuncts about itself.
    const handed =
      node.type.includes('Join') || node.type === 'Nested Loop' || HOLDS.has(node.type)
        ? conditions
        : [];
    for (const child of node.children) walk(child, below, handed);
  };
  walk(root, false, []);
  const probes = probesOf(scans);
  return verdicts.map((verdict, at) => {
    const found = probes[scans.findIndex((scan) => scan.verdict === at)] ?? [];
    return found.length === 0 ? verdict : { ...verdict, probes: found };
  });
}
