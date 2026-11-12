// The ONE search path: a chain's `.search(term)` asks the INSTALLED `SearchIndex`. The built-in
// Postgres index answers inside the statement (its `matches` predicate, today's SQL, untouched);
// any other index is asked for ids first, and the chain then reads those rows with its own
// tenancy, soft delete, order and cursor — so a Meilisearch hit can never widen what the chain sees.

import { tryUseContext } from '@ultimat3/core';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { MAX_PAGE_SIZE } from './plan';
import type { FindManyArgs, Repo } from './repo';
import { SEARCH_PROPERTY } from './search';
import { searchIndex } from './search-index-installed';
import { answersInStatement } from './search-index-postgres';
import type { Predicate } from './tenancy';

const isMatch = (predicate: Predicate): boolean =>
  predicate.column === SEARCH_PROPERTY && predicate.op === 'matches';

/** The tenant the chain is scoped to: its own `eq` on the tenant column, else the actor's. */
const tenantOf = (entity: EntityCore<unknown>, where: readonly Predicate[]): string | null => {
  const column = entity.$tenantColumn;
  if (column === null) return null;
  const named = where.find((each) => each.column === column && each.op === 'eq');
  if (typeof named?.value === 'string') return named.value;
  return tryUseContext()?.actor.orgId ?? null;
};

/** The single key a hit's id is read back by; a composite key has no `in` an index id can name. */
const keyOf = (entity: EntityCore<unknown>): string => {
  const [key, ...rest] = entity.$primaryKey;
  if (key === undefined || rest.length > 0) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `search of ${entity.$name} through an external index needs a single-column primary key; it has ${entity.$primaryKey.length}`,
      fix: 'installSearchIndex(postgresSearchIndex()) — the built-in index matches inside the statement, whatever the key',
    });
  }
  return key;
};

/**
 * A full answer is refused, never read: the index stops at `MAX_PAGE_SIZE` hits, so a full list
 * cannot say whether more matched, and an `in` over it would count, group and page a sample as
 * if it were every match — where the built-in index counts them all. Not `MAX_PAGE_SIZE + 1`: that
 * is past the limit every adapter accepts (`searchLimitOf`), so it would break the ones that check
 * it. The cost is exactly `MAX_PAGE_SIZE` matches being refused too. The index is asked by term and
 * tenant alone, so the chain's other filters cannot narrow what it answers: the term must.
 */
const tooManyHits = (entity: EntityCore<unknown>, indexName: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entity.$name}.search(<term>) matched ${MAX_PAGE_SIZE} or more rows in the '${indexName}' search index — it answers at most ${MAX_PAGE_SIZE} ids, so a count, a breakdown or a page over them would be a sample, not every match`,
    fix: `${entity.$name}.search('<a more specific term>')   # every word must match, so each one added narrows the hits; or installSearchIndex(postgresSearchIndex()) to match inside the statement, unbounded`,
  });

/** `args` with every `matches` predicate replaced by the ids the installed index answers. */
const resolved = async (entity: EntityCore<unknown>, args: FindManyArgs): Promise<FindManyArgs> => {
  const where = args.where ?? [];
  const index = searchIndex();
  if (answersInStatement(index)) return args;
  const tenant = tenantOf(entity, where);
  const swapped: Predicate[] = [];
  for (const predicate of where) {
    if (!isMatch(predicate)) {
      swapped.push(predicate);
      continue;
    }
    const hits = await index.query({
      entity: entity.$name,
      tenant,
      term: String(predicate.value ?? ''),
      limit: MAX_PAGE_SIZE,
    });
    if (hits.length >= MAX_PAGE_SIZE) throw tooManyHits(entity, index.name);
    swapped.push({ column: keyOf(entity), op: 'in', value: hits.map((hit) => hit.id) });
  }
  return { ...args, where: swapped };
};

const searching = (args: FindManyArgs | undefined): boolean => args?.where?.some(isMatch) === true;

/**
 * `repo` with every read that takes a chain's arguments routed through `resolved` — only when the
 * chain searched, so a read with no `.search()` reaches the repository exactly as before.
 */
export const searchedRepo = <Row>(entity: EntityCore<Row>, repo: Repo<Row>): Repo<Row> => {
  const core = entity as EntityCore<unknown>;
  const series = repo.series;
  const aggregates = repo.aggregates;
  const latestBy = repo.latestBy;
  return {
    ...repo,
    findMany: async (args) =>
      repo.findMany(searching(args) ? await resolved(core, args ?? {}) : args),
    count: async (args) => repo.count(searching(args) ? await resolved(core, args ?? {}) : args),
    countBy: async (column, args, options) =>
      repo.countBy(column, searching(args) ? await resolved(core, args ?? {}) : args, options),
    aggregate: async (fn, column, args) =>
      repo.aggregate(fn, column, searching(args) ? await resolved(core, args ?? {}) : args),
    approximateCount: async (args) =>
      repo.approximateCount(searching(args) ? await resolved(core, args ?? {}) : args),
    ...(aggregates === undefined
      ? {}
      : {
          aggregates: async (measures, args) =>
            aggregates.call(
              repo,
              measures,
              searching(args) ? await resolved(core, args ?? {}) : args,
            ),
        }),
    ...(latestBy === undefined
      ? {}
      : {
          latestBy: async (spec, args) =>
            latestBy.call(repo, spec, searching(args) ? await resolved(core, args ?? {}) : args),
        }),
    ...(series === undefined
      ? {}
      : {
          series: async (spec, args) =>
            series.call(repo, spec, searching(args) ? await resolved(core, args ?? {}) : args),
        }),
  };
};
