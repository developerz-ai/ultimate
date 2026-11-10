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
  return {
    ...repo,
    findMany: async (args) =>
      repo.findMany(searching(args) ? await resolved(core, args ?? {}) : args),
    count: async (args) => repo.count(searching(args) ? await resolved(core, args ?? {}) : args),
    countBy: async (column, args) =>
      repo.countBy(column, searching(args) ? await resolved(core, args ?? {}) : args),
    aggregate: async (fn, column, args) =>
      repo.aggregate(fn, column, searching(args) ? await resolved(core, args ?? {}) : args),
    approximateCount: async (args) =>
      repo.approximateCount(searching(args) ? await resolved(core, args ?? {}) : args),
    ...(series === undefined
      ? {}
      : {
          series: async (spec, args) =>
            series.call(repo, spec, searching(args) ? await resolved(core, args ?? {}) : args),
        }),
  };
};
