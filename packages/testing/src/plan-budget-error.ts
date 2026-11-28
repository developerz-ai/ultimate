// The two refusals of `expectPlanWithin`: a plan over the budget the test set (the code is
// registered in `errors.ts`), and an answer that is no plan, which is never read as a free one.

import {
  renderCauseValue,
  renderFixLiteral,
  renderFixShellArg,
  UltimateError,
} from '@ultimat3/core';
import type { PlanBudget, PlanRead } from './plan-budget-read';

/** The index `planFindings` named for the red node: the entity, and the properties it leads with. */
export interface PlanIndexFix {
  readonly entity: string;
  readonly property: readonly string[];
  /** The whole `indexes:` entry when a bare `on:` would not serve it (a trigram index). */
  readonly declaration?: string | undefined;
}

export class PlanOverBudgetError extends UltimateError {
  constructor(input: {
    readonly read: PlanRead;
    readonly budget: PlanBudget;
    readonly index?: PlanIndexFix | undefined;
  }) {
    const { read, budget, index } = input;
    const table = renderFixShellArg(read.table, '<table>');
    const entry =
      index?.declaration ??
      `indexes: [{ on: [${index?.property.map((p) => `'${p}'`).join(', ')}] }]`;
    super({
      code: 'X_QUERY_PLAN_OVER_BUDGET',
      cause: `the planner estimates total cost ${String(read.totalCost)} (budget ${String(budget.maxCost)}) and ${String(read.sortRows)} rows sorted (budget ${String(budget.maxSortRows)}), at ${renderCauseValue(read.node)} on ${renderCauseValue(read.table)}`,
      fix:
        index === undefined
          ? `x db gen "index ${table} <columns>" — after indexes: [{ on: ['<columns>'] }] in the entity of ${table}; or analyze ${table} after seeding, and raise the budget only by the measured number`
          : `x db gen "index ${table}" — after ${entry} in entity(${renderFixLiteral(index.entity, '<entity>')})`,
      meta: {
        totalCost: read.totalCost,
        sortRows: read.sortRows,
        node: read.node,
        table: read.table,
      },
    });
  }
}

/** The answer handed to the budget reader holds no `Total Cost`: it is not `explain (format json)`. */
export class PlanUnreadableError extends UltimateError {
  constructor() {
    super({
      code: 'X_QUERY_PLAN_UNAVAILABLE',
      cause:
        'expectPlanWithin read an explain answer with no plan root and no Total Cost, so no budget was judged',
      fix: 'expectPlanWithin(sql`select …`, { maxCost: 500, maxSortRows: 1000 })   # a select the database can plan',
    });
  }
}
