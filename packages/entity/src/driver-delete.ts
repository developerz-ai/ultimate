// Single responsibility: a custom store's HARD delete. The rows are read and scope-checked first,
// then deleted by their checked keys only — a store whose filter ignores the tenant is refused
// before it removes anything, rather than discovered by the rows another tenant no longer has.

import { valueAt } from './cursor';
import type { DriverScope } from './driver-scope';
import { describeCommand, EntityError } from './errors';
import { MAX_ASSERTED_ROWS } from './invariants';
import type { RepoOptions } from './repo';
import type { Predicate, QueryPlan } from './tenancy';

const tooMany = (entityName: string, operation: string, matched: number): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.${operation}() matches more than ${MAX_ASSERTED_ROWS} rows (${matched} read) on a custom driver, whose delete is checked row by row before the store removes any. Sweep the filter with .where(filter).inBatches(1000) and delete each page`,
    fix: `${describeCommand(entityName)}   # the entity whose filtered delete must be swept in pages`,
  });

/** The key predicates that name exactly these rows, beside the plan's own. */
const byKeys = <Row>(scope: DriverScope<Row>, plan: QueryPlan, rows: readonly Row[]) => {
  const keys = scope.entity.$primaryKey;
  const [only] = keys;
  if (keys.length === 1 && only !== undefined) {
    const where: Predicate[] = [
      { column: only, op: 'in', value: rows.map((row) => valueAt(row, only)) },
      ...plan.where,
    ];
    return [{ ...plan, where }];
  }
  return rows.map((row) => ({
    ...plan,
    where: [
      ...keys.map((key): Predicate => ({ column: key, op: 'eq', value: valueAt(row, key) })),
      ...plan.where,
    ],
  }));
};

/** Answers how many rows the store removed. */
export const checkedDelete = async <Row>(
  scope: DriverScope<Row>,
  op: string,
  plan: QueryPlan,
  options: RepoOptions | undefined,
): Promise<number> => {
  const tx = scope.txOf(op, options);
  const found = scope.checked(
    op,
    plan,
    await scope.raw.select({ plan, after: undefined, limit: MAX_ASSERTED_ROWS + 1, tx }),
  );
  if (found.length > MAX_ASSERTED_ROWS) throw tooMany(scope.entity.$name, op, found.length);
  if (found.length === 0) return 0;
  let removed = 0;
  for (const keyed of byKeys(scope, plan, found)) {
    removed += await scope.raw.delete({ plan: keyed, tx });
  }
  return removed;
};
