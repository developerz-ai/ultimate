// Reads one `explain (format json)` answer for a budget: the root's `Total Cost` and the largest
// `Plan Rows` on any `Sort`. Pure; the judge of which index would end it is `plan-oracle.ts`'s.

import { PlanUnreadableError } from './plan-budget-error';
import { planRoot } from './plan-oracle';

export interface PlanBudget {
  readonly maxCost: number;
  readonly maxSortRows: number;
}

export interface PlanRead {
  readonly totalCost: number;
  /** The largest estimated row count under any `Sort`; 0 when the plan sorts nothing. */
  readonly sortRows: number;
  /** The node the budget broke on: the largest `Sort`, else the root. */
  readonly node: string;
  /** The first physical table read beneath that node, or `''`. */
  readonly table: string;
}

type Raw = Readonly<Record<string, unknown>>;

const record = (value: unknown): Raw | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const children = (node: Raw): readonly Raw[] =>
  Array.isArray(node['Plans'])
    ? node['Plans'].flatMap((c: unknown): Raw[] => {
        const child = record(c);
        return child === undefined ? [] : [child];
      })
    : [];

const tableBeneath = (node: Raw): string => {
  if (typeof node['Relation Name'] === 'string') return node['Relation Name'];
  for (const child of children(node)) {
    const found = tableBeneath(child);
    if (found !== '') return found;
  }
  return '';
};

const sortsIn = (node: Raw): readonly Raw[] => [
  ...(node['Node Type'] === 'Sort' ? [node] : []),
  ...children(node).flatMap(sortsIn),
];

/** The numbers a budget judges. A plan with no root `Total Cost` is refused, never read as free. */
export function readPlanBudget(answer: unknown): PlanRead {
  const root = record(planRoot(answer));
  const totalCost = num(root?.['Total Cost']);
  if (root === undefined || totalCost === undefined) {
    throw new PlanUnreadableError();
  }
  const largest = sortsIn(root).reduce<Raw | undefined>(
    (best, sort) =>
      (num(sort['Plan Rows']) ?? 0) > (num(best?.['Plan Rows']) ?? -1) ? sort : best,
    undefined,
  );
  const at = largest ?? root;
  return {
    totalCost,
    sortRows: num(largest?.['Plan Rows']) ?? 0,
    node: typeof at['Node Type'] === 'string' ? at['Node Type'] : 'unknown',
    table: tableBeneath(at),
  };
}

export const overBudget = (read: PlanRead, budget: PlanBudget): boolean =>
  read.totalCost > budget.maxCost || read.sortRows > budget.maxSortRows;
