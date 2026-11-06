// The plan oracle: one `explain (format json)` plan, taken with sequential scans, bitmap scans and
// sorts disabled, in; the nodes no index could replace, out. Under those settings the planner picks
// a scan or a sort only when nothing else answers, so the verdict reads the schema, not the rows.
// Pure: JSON in, verdicts out (plan 101, 40-next-query-plans).

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
  /** The sort's columns on that table, in order. Empty for a scan. */
  readonly order: readonly string[];
}

interface PlanNode {
  readonly type: string;
  readonly table: string | undefined;
  readonly alias: string | undefined;
  readonly conditions: readonly string[];
  readonly sortKey: readonly string[];
  readonly indexCond: boolean;
  readonly filter: boolean;
  readonly children: readonly PlanNode[];
}

const SCANS: ReadonlySet<string> = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan']);
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
    indexCond: text(raw['Index Cond']) !== undefined,
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

const IDENT = /(?:"?([A-Za-z_][\w$]*)"?\.)?"?([A-Za-z_][\w$]*)"?/g;
const EQUALITY = /(?<![<>!])=(?!>)/;

/**
 * The columns of `scan` a condition names, split by how they are compared. A conjunct qualified by
 * another alias is a join's other side; an unqualified name counts when the table has the column.
 */
function columnsIn(
  conditions: readonly string[],
  scan: PlanNode,
  columns: ReadonlySet<string>,
): { readonly equality: string[]; readonly range: string[] } {
  const equality: string[] = [];
  const range: string[] = [];
  for (const condition of conditions) {
    for (const conjunct of condition.split(/\bAND\b/)) {
      const into = EQUALITY.test(conjunct) ? equality : range;
      for (const [, qualifier, name] of conjunct.replace(/'[^']*'/g, '').matchAll(IDENT)) {
        if (name === undefined || !columns.has(name)) continue;
        if (qualifier !== undefined && qualifier !== scan.alias && qualifier !== scan.table)
          continue;
        if (!equality.includes(name) && !range.includes(name)) into.push(name);
      }
    }
  }
  return { equality, range: range.filter((name) => !equality.includes(name)) };
}

/** The first scan beneath `node` (the node itself included) that reads one of `tables`. */
const scanBeneath = (node: PlanNode, tables: PlanTableColumns): PlanNode | undefined =>
  node.table !== undefined && SCANS.has(node.type) && tables.has(node.table)
    ? node
    : node.children.reduce<PlanNode | undefined>(
        (found, child) => found ?? scanBeneath(child, tables),
        undefined,
      );

/** Physical table → its physical columns: only these tables are judged. */
export type PlanTableColumns = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Every red node of one plan. `Seq Scan` on a judged table; an index scan with no `Index Cond`,
 * unless a `Limit` above it stops it early and no `Filter` makes it walk on; a `Sort` under a
 * `Limit`. A join's conditions are handed down, so the scan of its inner side names its key.
 */
export function judgePlan(answer: unknown, tables: PlanTableColumns): readonly PlanVerdict[] {
  const root = nodeOf(planRoot(answer));
  if (root === undefined) return [];
  const verdicts: PlanVerdict[] = [];
  const walk = (node: PlanNode, limited: boolean, inherited: readonly string[]): void => {
    const conditions = [...inherited, ...node.conditions];
    const columns = node.table === undefined ? undefined : tables.get(node.table);
    if (node.table !== undefined && columns !== undefined && SCANS.has(node.type)) {
      const unbounded = node.type === 'Seq Scan' || (!node.indexCond && (!limited || node.filter));
      if (unbounded) {
        const found = columnsIn(conditions, node, columns);
        verdicts.push({
          code: 'X_QUERY_UNINDEXED',
          node: node.type,
          table: node.table,
          ...found,
          order: [],
        });
      }
    }
    if (node.type === 'Sort' && limited) {
      const scan = scanBeneath(node, tables);
      const scanColumns = scan?.table === undefined ? undefined : tables.get(scan.table);
      if (scan?.table !== undefined && scanColumns !== undefined) {
        const found = columnsIn([...conditions, ...scan.conditions], scan, scanColumns);
        const order = columnsIn(node.sortKey, scan, scanColumns);
        verdicts.push({
          code: 'X_QUERY_SORT_UNSERVED',
          node: node.type,
          table: scan.table,
          equality: found.equality,
          range: [],
          order: [...order.equality, ...order.range],
        });
      }
    }
    const below = limited || node.type === 'Limit';
    // A join's conditions name both sides: each child keeps only the conjuncts about itself.
    const handed =
      node.type.includes('Join') || node.type === 'Nested Loop' || node.type === 'Hash'
        ? conditions
        : [];
    for (const child of node.children) walk(child, below, handed);
  };
  walk(root, false, []);
  return verdicts;
}
