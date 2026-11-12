// Single responsibility: what a newest-row-per-group read means — the spec a driver answers, the
// plan both drivers build it from, the bound on how many groups one call may answer, and the
// answer for a repository that cannot send the one statement (`latestRows`). Postgres sends
// `DISTINCT ON` or `LATERAL` (`latest-by-sql.ts`); memory folds the same plan (`memory-latest-by.ts`).

import { keyOf } from './batch-read';
import { groupColumnOf, MAX_GROUPS } from './count-by';
import { valueAt } from './cursor';
import type { EntityCore } from './entity';
import { describeCommand, EntityError } from './errors';
import { MAX_PAGE_SIZE, readPlan } from './plan';
import type { FindManyArgs, Repo } from './repo';
import type { Predicate, QueryPlan, SortDirection, SortKey } from './tenancy';
import type { NoSealedKeys, SealedKeySet } from './types';

/** The groups one `latestBy` may answer: `countBy`'s bound, refused past it and never truncated. */
export const MAX_LATEST_GROUPS = MAX_GROUPS;

/**
 * What a driver's `latestBy` is asked. `order` is the caller's, without the group and without the
 * tiebreak — the plan adds both. `keys`, when present, are the only groups wanted (a preload's
 * parents) and `perGroup` may then exceed one; without them it is the newest row of every group
 * the predicate matches, one each.
 */
export interface LatestBySpec {
  readonly group: string;
  readonly order: readonly SortKey[];
  readonly perGroup: number;
  readonly keys?: readonly unknown[];
}

/** `ReadBuilder.latestBy`'s options: the column that says which row is newest, descending unless stated. */
export interface LatestByOptions<K extends string = string> {
  readonly order: K;
  readonly direction?: SortDirection;
}

export interface ReadLatest<Row, S extends SealedKeySet = NoSealedKeys> {
  /**
   * The newest row of every group the chain matches, in ONE statement — "the last message of each
   * conversation" is `messages.andWhere('conversationId', 'in', ids).latestBy('conversationId',
   * { order: 'createdAt' })`, not one `.orderBy().one()` per conversation. Ties go to the primary
   * key in the same direction. Rows come back ordered by the group, `null` last; a group with no
   * row is absent. Past `MAX_LATEST_GROUPS` groups it is refused, never truncated, and the chain's
   * own `orderBy()`, `limit()` and `after()` are refused: one row per group is the whole shape.
   */
  latestBy<
    G extends Exclude<keyof Row & string, S['sealed']>,
    K extends Exclude<keyof Row & string, S['sealed']>,
  >(group: G, options: LatestByOptions<K>): Promise<readonly Row[]>;
}

const refused = (entityName: string, cause: string, fix: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause,
    fix: `${describeCommand(entityName)}   # ${fix}`,
  });

/** The per-group count a spec asks for: a whole number of rows, at least one, at most a page. */
const assertPerGroup = <Row>(entity: EntityCore<Row>, spec: LatestBySpec, op: string): void => {
  const n = spec.perGroup;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
    throw refused(
      entity.$name,
      `${entity.$name}.${op}('${spec.group}') asks for ${String(n)} rows per group — a whole number, at least 1 and at most ${MAX_PAGE_SIZE}`,
      `{ perParent: 1 }   # on that ${op}() call: a whole number of rows per group, 1 to ${MAX_PAGE_SIZE}`,
    );
  }
  // `DISTINCT ON` keeps one row; more than one per group needs the groups named, which is the
  // statement (`LATERAL`) that reads n rows per key off an index instead of every row of them.
  if (n > 1 && spec.keys === undefined) {
    throw refused(
      entity.$name,
      `${entity.$name}.${op}('${spec.group}') asks for ${n} rows per group without naming the groups — more than one row per group is a preload over known parents`,
      `parents.preload('<relation>', { perParent: ${n} })   # a preload names the groups, its parents; latestBy names none`,
    );
  }
};

/**
 * The read both drivers plan: the chain's scope, ordered by the group first, then the caller's
 * order, then the primary key in the last key's direction — which is what `DISTINCT ON` needs
 * leading its `order by`, and what makes "the first row of each group" one row in both drivers.
 * With `keys`, an `in` predicate on the group joins the scope. No page and no cursor: not a page.
 */
export const latestArgs = <Row>(
  entity: EntityCore<Row>,
  spec: LatestBySpec,
  args: FindManyArgs,
) => {
  const keyed: readonly Predicate[] =
    spec.keys === undefined ? [] : [{ column: spec.group, op: 'in', value: spec.keys }];
  const { cursor: _cursor, limit: _limit, ...scope } = args;
  return {
    ...scope,
    where: [...(args.where ?? []), ...keyed],
    // The tiebreak follows the LAST key's direction (`totalOrder`), so an empty order is the
    // primary key descending — "latest" by the uuid-v7 id every entity's default key mints.
    orderBy: [
      { column: spec.group, direction: 'asc' as const },
      ...(spec.order.length === 0
        ? entity.$primaryKey.map((column) => ({ column, direction: 'desc' as const }))
        : spec.order),
    ],
  } satisfies FindManyArgs;
};

/** The plan, guarded as `readPlan` guards every read: tenancy, screening, a total order. */
export const latestPlanOf = <Row>(
  entity: EntityCore<Row>,
  spec: LatestBySpec,
  args: FindManyArgs,
  op = 'latestBy',
): QueryPlan => {
  groupColumnOf(entity, spec.group, op);
  assertPerGroup(entity, spec, op);
  return readPlan(entity, latestArgs(entity, spec, args), op);
};

/**
 * The string a group is filed under, spelled as a batch spells a key (`keyOf`): a `uuid` handed in
 * upper case is the group Postgres compares it into. `null` is its own bucket, apart from the text
 * `'null'`, as `group by` keeps them.
 */
const groupKey = (kind: string, value: unknown): string =>
  value === null || value === undefined ? '\u0000null' : `v:${keyOf(kind, value)}`;

/**
 * The first `perGroup` rows of each group, from rows already in the plan's order — the fold the
 * memory driver and the paged fallback share, so the two cannot disagree about which row is first.
 */
export const firstPerGroup = <Row>(
  rows: readonly Row[],
  group: { readonly column: string; readonly kind: string },
  perGroup: number,
): readonly Row[] => {
  const taken = new Map<string, number>();
  const kept: Row[] = [];
  for (const row of rows) {
    const key = groupKey(group.kind, valueAt(row, group.column));
    const count = taken.get(key) ?? 0;
    if (count >= perGroup) continue;
    taken.set(key, count + 1);
    kept.push(row);
  }
  return kept;
};

/** The group column as the fold reads it: its name and its declared kind. */
export const groupOf = <Row>(entity: EntityCore<Row>, spec: LatestBySpec) => ({
  column: spec.group,
  kind: entity.$columns[spec.group]?.$meta.kind ?? '',
});

/** How many distinct groups some rows span. */
export const groupsIn = (
  rows: readonly unknown[],
  group: { readonly column: string; readonly kind: string },
): number => new Set(rows.map((row) => groupKey(group.kind, valueAt(row, group.column)))).size;

/**
 * Refused past the bound, never truncated: a map of "the newest row per conversation" missing its
 * tail reads exactly like a complete one. Only a read with no `keys` can reach it — a preload's
 * groups are its parents, which the page already bounds.
 */
export const assertGroupBound = <Row>(
  entity: EntityCore<Row>,
  spec: LatestBySpec,
  groups: number,
): void => {
  if (spec.keys !== undefined || groups <= MAX_LATEST_GROUPS) return;
  throw refused(
    entity.$name,
    `${entity.$name}.latestBy('${spec.group}') matched more than ${MAX_LATEST_GROUPS} groups — bound the chain first: ${entity.$name}.andWhere('${spec.group}', 'in', <values>).latestBy('${spec.group}', { order })`,
    `andWhere('${spec.group}', 'in', <values>).latestBy('${spec.group}', { order })   # bound the groups first, or page them with inBatches()`,
  );
};

/** Rows per `findMany` statement when a repository has no `latestBy` of its own. */
const FALLBACK_PAGE = 1000;

/**
 * The answer for a repository without `latestBy` (a hand-written driver, a wrapper that does not
 * forward it): every matched row in the plan's order, a page at a time, folded. Correct, never
 * one statement — which is what the method exists to be, so a driver that can should implement it.
 */
const pagedLatest = async <Row>(
  entity: EntityCore<Row>,
  repo: Repo<Row>,
  spec: LatestBySpec,
  args: FindManyArgs,
): Promise<readonly Row[]> => {
  latestPlanOf(entity, spec, args);
  const read = latestArgs(entity, spec, args);
  const group = groupOf(entity, spec);
  const kept: Row[] = [];
  let cursor: string | null = null;
  do {
    const page = await repo.findMany({
      ...read,
      limit: FALLBACK_PAGE,
      cursor,
    });
    kept.push(...page.rows);
    // Folded per page so memory holds the answer, never the table.
    kept.splice(0, kept.length, ...firstPerGroup(kept, group, spec.perGroup));
    assertGroupBound(entity, spec, groupsIn(kept, group));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return kept;
};

/** The one door: the driver's statement when it has one, the paged fold when it has not. */
export const latestRows = <Row>(
  entity: EntityCore<Row>,
  repo: Repo<Row>,
  spec: LatestBySpec,
  args: FindManyArgs = {},
): Promise<readonly Row[]> =>
  repo.latestBy === undefined ? pagedLatest(entity, repo, spec, args) : repo.latestBy(spec, args);

/**
 * The chain's terminal, before the projection and the preloads (`query.ts` attaches those). A
 * chain that also named an order, a page size or a cursor is refused: each is a second answer to
 * "which rows", and silently dropping one is a read the author did not write.
 */
export const latestByRows = <Row>(
  entity: EntityCore<Row>,
  repo: Repo<Row>,
  group: string,
  options: LatestByOptions,
  args: FindManyArgs,
): Promise<readonly Row[]> => {
  const extra = [
    (args.orderBy?.length ?? 0) > 0 ? 'orderBy()' : undefined,
    args.limit === undefined ? undefined : 'limit()',
    args.cursor === undefined || args.cursor === null ? undefined : 'after()',
  ].filter((each) => each !== undefined);
  if (extra.length > 0) {
    throw refused(
      entity.$name,
      `${entity.$name}.latestBy('${group}') on a chain that also called ${extra.join(', ')} — latestBy answers one row per group, ordered by { order }, and takes no page`,
      `latestBy('${group}', { order, direction })   # on a chain without ${extra.join(', ')}: { order, direction } picks the newest row`,
    );
  }
  const order = [{ column: options.order, direction: options.direction ?? 'desc' }] as const;
  return latestRows(entity, repo, { group, order, perGroup: 1 }, args);
};
