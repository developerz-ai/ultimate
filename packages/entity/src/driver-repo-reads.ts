// Single responsibility: the read half of a `defineDriver` repository. Each method builds its plan
// with `plan.ts` — the builders both shipped drivers use — so tenancy, the page bound, the total
// order and the cursor mean here what they mean on Postgres; the store only answers the plan.

import { pageOf } from '@ultimat3/core';
import { aggregateColumnOf } from './aggregate';
import { countsFrom, groupColumnOf } from './count-by';
import { cursorFor, seekFrom } from './cursor';
import { projectRow } from './driver-rows';
import type { DriverScope } from './driver-scope';
import { planMeasures, screenMeasureFilter } from './measures';
import { assertPageBytes } from './page-bytes';
import { idPlan, readPlan, singleKeyOf } from './plan';
import type { Repo } from './repo';
import { rowKey } from './row-key';
import type { Predicate } from './tenancy';
import { seriesPlanOf } from './time-bucket';

export type DriverReads<Row> = Pick<
  Repo<Row>,
  | 'findById'
  | 'findMany'
  | 'count'
  | 'countBy'
  | 'aggregate'
  | 'aggregates'
  | 'approximateCount'
  | 'series'
>;

export const driverReads = <Row>(scope: DriverScope<Row>): DriverReads<Row> => {
  const { entity, raw } = scope;
  const series = raw.series;
  return {
    async findById(id, options) {
      const op = 'findById';
      singleKeyOf(entity, op);
      const plan = scope.storePlan(op, idPlan(entity, id, options, op), options?.includeDeleted);
      const tx = scope.txOf(op, options);
      const found = await raw.select({ plan, after: undefined, limit: 1, tx });
      return scope.checked(op, plan, found)[0] ?? null;
    },

    async findMany(args = {}) {
      const op = 'findMany';
      // The cursor is minted and read against the plan `readPlan` built, never the store's copy:
      // `planScope` hashes the predicates, and the soft-delete one is the kit's, not the caller's.
      const plan = readPlan(entity, args, op);
      const after = seekFrom(entity, plan);
      const stored = scope.storePlan(op, plan, args.includeDeleted);
      const tx = scope.txOf(op, args);
      const found = scope.checked(
        op,
        stored,
        await raw.select({ plan: stored, after, limit: plan.limit + 1, tx }),
      );
      const page = found.slice(0, plan.limit);
      const last = page.at(-1);
      const next =
        found.length > plan.limit && last !== undefined
          ? cursorFor(entity, plan, last, rowKey(entity, last))
          : null;
      // Weighed projected, as memory weighs it: a store's page is bounded like the other two.
      const projected = page.map((row) => projectRow(entity, plan, row));
      assertPageBytes(entity, op, projected as readonly Readonly<Record<string, unknown>>[]);
      return pageOf(projected, next);
    },

    async count(args = {}) {
      const op = 'count';
      const plan = scope.storePlan(op, readPlan(entity, args, op), args.includeDeleted);
      return raw.count({ plan, tx: scope.txOf(op, args) });
    },

    /**
     * With `where`, two store calls over the one capability a store already declares: every group
     * the chain matches, then the groups' counts with the filter ANDed in — a group the filter
     * empties answers `0`, as `count(*) filter (where …)` does. No new store contract to forget.
     */
    async countBy(column, args = {}, options) {
      const op = 'countBy';
      groupColumnOf(entity, column, op);
      scope.need(op, 'aggregate:countBy');
      const tx = scope.txOf(op, args);
      const planOf = (where: readonly Predicate[]) =>
        scope.storePlan(op, readPlan(entity, { ...args, where }, op), args.includeDeleted);
      const groups = await raw.countBy?.(column, { plan: planOf(args.where ?? []), tx });
      const all = countsFrom(entity, column, op, groups ?? []);
      const filter = options?.where;
      if (filter === undefined || filter.length === 0) return all;
      const where = [...(args.where ?? []), ...screenMeasureFilter(entity, filter)];
      const hit = countsFrom(
        entity,
        column,
        op,
        (await raw.countBy?.(column, { plan: planOf(where), tx })) ?? [],
      );
      return new Map([...all.keys()].map((key) => [key, hit.get(key) ?? 0]));
    },

    /**
     * Every measure as the store call its function already is — `count` through `count`, the rest
     * through `aggregate` under its own `aggregate:<fn>` capability — each with its filter ANDed
     * into the plan. Several store calls, never one statement: a store has no select list.
     */
    async aggregates(measures, args = {}) {
      const op = 'aggregates';
      const planned = planMeasures(entity, measures);
      const tx = scope.txOf(op, args);
      const answer: Record<string, unknown> = {};
      for (const measure of planned) {
        const where = [
          ...(args.where ?? []),
          ...measure.where,
          ...(measure.fn === 'count' && measure.property !== undefined
            ? [{ column: measure.property, op: 'is-not-null' as const }]
            : []),
        ];
        const plan = scope.storePlan(
          op,
          readPlan(entity, { ...args, where }, op),
          args.includeDeleted,
        );
        if (measure.fn === 'count') {
          answer[measure.name] = await raw.count({ plan, tx });
          continue;
        }
        scope.need(measure.fn, `aggregate:${measure.fn}`);
        answer[measure.name] =
          (await raw.aggregate?.(measure.fn, measure.property ?? '', { plan, tx })) ?? null;
      }
      return answer;
    },

    async aggregate(fn, column, args = {}) {
      aggregateColumnOf(entity, fn, column);
      scope.need(fn, `aggregate:${fn}`);
      const plan = scope.storePlan(fn, readPlan(entity, args, fn), args.includeDeleted);
      return raw.aggregate?.(fn, column, { plan, tx: scope.txOf(fn, args) }) ?? null;
    },

    async approximateCount(args = {}) {
      const op = 'approximateCount';
      // `readPlan` refuses a filter or a tenant-scoped entity first, as on Postgres.
      readPlan(entity, args, op);
      scope.need(op, 'aggregate:approximateCount');
      return (await raw.approximateCount?.()) ?? null;
    },

    // Present only when declared, so the typed handle answers `X_ENTITY_SERIES_UNSUPPORTED` — the
    // shipped code for a repository without one — rather than a second code for the same fact.
    ...(series === undefined || !scope.definition.capabilities.includes('series')
      ? {}
      : {
          async series(spec, args = {}) {
            const op = 'series';
            seriesPlanOf(entity, spec);
            const plan = scope.storePlan(op, readPlan(entity, args, op), args.includeDeleted);
            return series.call(raw, spec, { plan, tx: scope.txOf(op, args) });
          },
        }),
  };
};
