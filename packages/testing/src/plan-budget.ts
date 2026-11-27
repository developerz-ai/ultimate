// `expectPlanWithin(fragment, { maxCost, maxSortRows })`: the app test's plan budget. Both numbers
// are the caller's — there is no default, because a budget is a measurement of that app's schema
// on that engine. Plans only: `explain (format json)` in a read-only transaction, never `analyze`,
// so the statement is not executed.

import type { DbClient, SqlFragment } from '@ultimat3/db';
import { db, sql, withReadTransaction } from '@ultimat3/db';
import './errors';
import { type PlanIndexFix, PlanOverBudgetError } from './plan-budget-error';
import { overBudget, type PlanBudget, readPlanBudget } from './plan-budget-read';
import { judgeStatement } from './plan-sweep';
import { planFindings } from './plan-sweep-fix';
import type { SeedEntity } from './seed-graph-shape';

export type { PlanBudget } from './plan-budget-read';

export interface ExpectPlanOptions {
  /** Default: the installed db client. */
  readonly client?: DbClient | undefined;
  /**
   * The app's entities. Given, an over-budget plan is judged once more and the error names the
   * `indexes:` entry that answers it; absent, the fix is `analyze`.
   */
  readonly entities?: readonly SeedEntity[] | undefined;
}

async function explainJson(fragment: SqlFragment, client: DbClient | undefined): Promise<unknown> {
  const rows = await withReadTransaction(
    (tx) => tx.query<Record<string, unknown>>(sql`explain (format json) ${fragment}`),
    { client },
  );
  return rows[0]?.['QUERY PLAN'];
}

async function indexFor(
  fragment: SqlFragment,
  client: DbClient,
  entities: readonly SeedEntity[],
): Promise<PlanIndexFix | undefined> {
  const tables = entities.filter((entity) => entity.$describe().view === undefined);
  const judged = new Map(
    tables.map((entity) => [
      entity.$table,
      new Set(entity.$describe().columns.map((c) => c.column)),
    ]),
  );
  const { verdicts } = await judgeStatement(client, fragment.text, judged);
  if (verdicts === undefined || verdicts.length === 0) return undefined;
  const byTable = new Map(tables.map((entity) => [entity.$table, entity]));
  const found = planFindings(fragment.text, verdicts, byTable).find((f) => f.index.length > 0);
  return found === undefined
    ? undefined
    : { entity: found.entity, property: found.index, declaration: found.declaration };
}

/**
 * Plan `fragment` with its real parameters and refuse past `maxCost` (the root's `Total Cost`) or
 * `maxSortRows` (the largest `Plan Rows` on any `Sort`). Analyze after seeding, and set one budget
 * per engine: PGlite and Postgres cost the same plan differently.
 */
export async function expectPlanWithin(
  fragment: SqlFragment,
  budget: PlanBudget,
  options: ExpectPlanOptions = {},
): Promise<void> {
  const read = readPlanBudget(await explainJson(fragment, options.client));
  if (!overBudget(read, budget)) return;
  const index =
    options.entities === undefined
      ? undefined
      : await indexFor(fragment, options.client ?? db(), options.entities);
  throw new PlanOverBudgetError({ read, budget, index });
}
