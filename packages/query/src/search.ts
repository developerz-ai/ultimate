/**
 * `search()` — a QUERY FACTORY over an entity's `.searchable()` columns, the shape `llm()` and
 * `backfill()` already have. It returns a `query`, so a search inherits the policy, the cache tags,
 * the MCP tool, the typed client, the route and its manifest row rather than becoming a ninth
 * primitive. What it adds is the one thing a hand-written read gets wrong: the term never becomes
 * syntax, and the tenant predicate is never optional.
 */

import { assert, type Ctx } from '@ultimat3/core';
import type { InferOutput, Shape, Simplify } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { QueryPolicy } from './policy-gate';
import type { QueryCache, QueryMcp, QueryRateLimit } from './query';
import { query } from './query';
import type { SeekKey } from './shape';
import type { SqlSource, SqlText } from './source';
import { from } from './source';

/**
 * What `@ultimat3/entity`'s `ReadBuilder` answers, crossed STRUCTURALLY.
 *
 * This package may import `@ultimat3/entity` (tier 2) and deliberately does not: nothing here does
 * today, so a real dependency would be a new edge in `package.json` and a new block in `bun.lock`
 * for four methods. Same trade `@ultimat3/db`'s `entity-shape.ts` makes one tier down, and the same
 * discipline — the shape is the contract, and a chain that does not satisfy it does not compile.
 */
export interface SearchChain<Row extends object> {
  /** Appends the full-text predicate. The TERM, never a tsquery. */
  search(term: string): SearchChain<Row>;
  limit(rows: number): SearchChain<Row>;
  all(): Promise<readonly Row[]>;
  /** Only `entity` is read — the name the `SqlSource` and every cache tag are keyed by. */
  plan(): { readonly entity: string };
}

export interface SearchPage {
  /** The largest page this read will serve. Bounded in the INPUT SCHEMA, so a client cannot ask past it. */
  readonly max?: number;
  readonly default?: number;
}

const DEFAULT_PAGE_MAX = 100;
const DEFAULT_PAGE_SIZE = 20;
/**
 * The longest term accepted. A `tsquery` past ~1 MB is a server error, and a search box does not
 * send a novel — the bound belongs in the schema so it is refused before a statement exists.
 */
const DEFAULT_TERM_MAX = 200;

export interface SearchDef<S extends Shape, Row extends object> {
  /** The read's own input keys, beside `q` and `limit` — a tenant id, a status filter, a date. */
  readonly input?: S;
  readonly policy: QueryPolicy;
  /**
   * The chain this search runs on, WITHOUT the term: the tenancy, the filters and the ordering the
   * page is served in. `search()` adds `.search(q)` and `.limit(limit)` and nothing else, which is
   * what makes the term unable to arrive any other way.
   */
  in(args: { readonly input: SearchInput<S>; readonly ctx: Ctx }): SearchChain<Row>;
  readonly termMax?: number;
  readonly page?: SearchPage;
  readonly cache?: QueryCache;
  readonly mcp?: QueryMcp;
  readonly rateLimit?: QueryRateLimit;
}

type SearchShape<S extends Shape> = Simplify<
  S & { q: ReturnType<typeof termSchema>; limit: ReturnType<typeof limitSchema> }
>;

export type SearchInput<S extends Shape> = InferOutput<ReturnType<typeof t.object<SearchShape<S>>>>;

const termSchema = (max: number) => t.string.min(1).max(max);

const limitSchema = (max: number, fallback: number) =>
  t.number.int().min(1).max(max).default(fallback);

/**
 * A search serves ONE page, and asking for a second is refused rather than answered wrongly.
 *
 * The rows come from the entity chain, which pages by its own keyset cursor — proven against a real
 * server in `packages/entity/src/pg-search.live.test.ts`. That cursor cannot cross this seam: a
 * `SqlSource` is handed a `SeekKey` (the previous page's sort VALUES) and the chain wants its own
 * signed, plan-scoped string, and there is no way to mint one from the other here. Falling through
 * to `paginate`'s in-memory slice would cut inside the one page the provider fetched and report
 * `hasNextPage: false` at its edge — rows served on no page at all, which is the defect 12.0.0 spent
 * a release removing from the timestamp seek. So it is a refusal with the alternative in the `fix`:
 * page with the entity chain's own `.search(term).after(cursor)`, or raise this read's `limit`.
 */
const onePage = <Row extends object>(base: SqlSource<Row>, entity: string): SqlSource<Row> => ({
  toSQL: (): SqlText => base.toSQL(),
  execute: () => base.execute(),
  shape: () => base.shape(),
  ...(base.total === undefined ? {} : { total: () => onePage(base.total?.() ?? base, entity) }),
  seek: (after: SeekKey | null, limit: number): SqlSource<Row> => {
    assert(
      after === null,
      `search of ${entity} serves one page: a relevance-filtered read has no cursor this layer can carry`,
      `db.${entity}.search(term).orderBy('<key>').after(cursor).page()   # the entity chain pages this read — or raise its limit`,
    );
    return onePage(base.seek?.(after, limit) ?? base, entity);
  },
});

/**
 * The factory. `live: false` and the source declares itself unpatchable, because the incremental
 * matcher decides membership from `QueryShape` filters and a `tsvector` match is not one of them —
 * a live search would have to re-read on every write to the table.
 */
export const search = <Row extends object, S extends Shape = Record<string, never>>(
  def: SearchDef<S, Row>,
) => {
  const page = def.page ?? {};
  const max = page.max ?? DEFAULT_PAGE_MAX;
  const shape = {
    ...((def.input ?? {}) as S),
    q: termSchema(def.termMax ?? DEFAULT_TERM_MAX),
    limit: limitSchema(max, Math.min(page.default ?? DEFAULT_PAGE_SIZE, max)),
  } as SearchShape<S>;

  return query({
    input: t.object(shape),
    policy: def.policy,
    live: false,
    ...(def.cache === undefined ? {} : { cache: def.cache }),
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    ...(def.rateLimit === undefined ? {} : { rateLimit: def.rateLimit }),
    sql: (input, ctx) => {
      const parsed = input as SearchInput<S> & { readonly q: string; readonly limit: number };
      // Trimmed and refused HERE, before the chain exists: `websearch_to_tsquery('english', '  ')`
      // is a legal empty tsquery matching nothing, so a blank box would answer "no results" as if
      // it had searched. Saying so is the difference between an empty answer and an empty question.
      const term = parsed.q.trim();
      assert(
        term.length > 0,
        'a search term of only whitespace is not a search',
        'guard the input before calling: if (term.trim() === "") return [] — an empty box is not an empty result set',
      );
      const chain = def.in({ input: parsed, ctx });
      const name = chain.plan().entity;
      const rows = () => chain.search(term).limit(parsed.limit).all();
      return onePage(from<Row>(name, rows).raw('full-text search'), name);
    },
  });
};
