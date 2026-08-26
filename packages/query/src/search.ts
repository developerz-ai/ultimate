/**
 * `search()` — a QUERY FACTORY over an entity's `.searchable()` columns, the shape `llm()` and
 * `backfill()` already have. It returns a `query`, so a search inherits the policy, the cache tags,
 * the MCP tool, the typed client, the route and its manifest row rather than becoming a ninth
 * primitive. What it adds is the one thing a hand-written read gets wrong: the term never becomes
 * syntax, and the tenant predicate is never optional.
 */

import { assert, type Ctx, finiteOption } from '@ultimat3/core';
import type { InferOutput, Shape, Simplify } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { QueryPolicy } from './policy-gate';
import type { QueryCache, QueryMcp, QueryRateLimit } from './query';
import { query } from './query';
import type { SeekKey } from './shape';
import type { Builder, SqlSource, SqlText } from './source';
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
 * A search serves ONE page, in the order the chain served it, and asking for a second is refused
 * rather than answered wrongly.
 *
 * The rows come from the entity chain, which pages by its own keyset cursor — proven against a real
 * server in `packages/entity/src/pg-search.live.test.ts`. That cursor cannot cross this seam: a
 * `SqlSource` is handed a `SeekKey` (the previous page's sort VALUES) and the chain wants its own
 * signed, plan-scoped string, and there is no way to mint one from the other here. Falling through
 * to `paginate`'s in-memory slice would cut inside the one page the provider fetched and report
 * `hasNextPage: false` at its edge — rows served on no page at all, which is the defect 12.0.0 spent
 * a release removing from the timestamp seek. So it is a refusal with the alternative in the `fix`:
 * page with the entity chain's own `.search(term).after(cursor)`, or raise this read's `limit`.
 *
 * **The refusal is on the rows that would be CUT, never on the window** (`As of 2026-08-26`). It
 * used to serve `first` rows, mint an `endCursor` and report `hasNextPage: true` — a connection
 * protocol saying "call me again with this" for a call the cursor assert is guaranteed to throw on.
 * A first repair demanded `first >= limit` and refused the window itself, which refuses the
 * framework's OWN default pair: `limit` defaults to 20 and `first` arrives from a client
 * (`{ first: query.pageSize }`), so every `pageSize` under 20 was a 500 at page ONE — including
 * every search that matched three rows and fit the window twice over. A screen that fires on a
 * request the read can answer completely is not protecting anyone.
 *
 * So the condition is the one thing that is actually wrong: the read answered MORE rows than the
 * window carries, and this seam has no second page to put the rest on. Below that, the page is
 * whole and `hasNextPage` is false by construction — the true stop signal, and no cursor is ever
 * handed back that a second call is guaranteed to refuse.
 *
 * **`seek` narrows the WINDOW and never the ORDER, and that is the whole reason this wrapper takes a
 * `Builder`.** `Builder.seek()` sets `totalized`, so `servedOrder()` becomes `totalOrder([])` —
 * `id asc`, because the relevance ordering lives inside the chain behind the row thunk and no key
 * here can name it — and `execute()` then re-sorts the page the provider already ranked. Measured
 * with a chain serving `z, m, a`: `runQuery` answered `z, m, a` and `.page(input, { first: 2 })`
 * answered `a, m`, dropping the top-ranked row off page one. `limit()` is the same window with no
 * ordering claim attached, which is what an already-ranked page needs.
 */
const onePage = <Row extends object>(
  base: Builder<Row>,
  entity: string,
  /** Rows the chain was capped at — this read's `limit` input, and its whole page. */
  served: number,
): SqlSource<Row> => ({
  toSQL: (): SqlText => base.toSQL(),
  execute: () => base.execute(),
  shape: () => base.shape(),
  // No `total()`: `SqlSource` reads its absence as "the source already serves one order it can be
  // resumed in", which is exactly true of a relevance ranking — and `total()` would totalize the
  // Builder, re-sorting that ranking by id for the same reason `seek` must not.
  seek: (after: SeekKey | null, window: number): SqlSource<Row> => {
    assert(
      after === null,
      `search of ${entity} serves one page: a relevance-filtered read has no cursor this layer can carry`,
      `db.${entity}.search(term).orderBy('<key>').after(cursor).page()   # the entity chain pages this read — or raise its limit`,
    );
    // `paginate` asks for `first + 1` — the extra row IS `hasNextPage` — so the window it names is
    // one wider than the page it will serve.
    return windowOf(base, entity, served, window - 1);
  },
});

/**
 * The one page, narrowed to the window `paginate` asked for and refused only when it does not FIT.
 *
 * The check is on the rows that came back, not on the two numbers, because those two numbers cannot
 * decide it: `first: 10` against a `limit` of 20 is a complete answer whenever the term matched ten
 * rows or fewer, which is most searches. Refusing it on the declaration alone made the framework's
 * own defaults a 500.
 *
 * The `fix:` names `served` — the read's declared `limit` — and never the count that came back: a
 * window sized to today's result set breaks on the first row added to the corpus.
 */
const windowOf = <Row extends object>(
  base: Builder<Row>,
  entity: string,
  served: number,
  /** Rows `paginate` will serve. It fetched one more, to decide `hasNextPage`. */
  first: number,
): SqlSource<Row> => {
  const windowed = base.limit(first + 1);
  return {
    toSQL: (): SqlText => windowed.toSQL(),
    shape: () => windowed.shape(),
    // No `seek()` and no `total()`: `paginate` seeks once, and `SqlSource` reads an absent `total`
    // as "the source already serves one order it can be resumed in" — exactly true of a relevance
    // ranking, which `total()` would re-sort by id for the same reason `seek` must not.
    execute: async () => {
      const rows = await windowed.execute();
      assert(
        rows.length <= first,
        `search of ${entity} answered more than the ${String(first)} rows .page() asked for, and this read has no second page: the rest would be on no page at all`,
        `read.page(input, { first: ${String(served)} })   # widen the window to the read's whole page — or narrow the page: read({ q, limit: ${String(first)} })`,
      );
      return rows;
    },
  };
};

/**
 * The factory. `live: false` and the source declares itself unpatchable, because the incremental
 * matcher decides membership from `QueryShape` filters and a `tsvector` match is not one of them —
 * a live search would have to re-read on every write to the table.
 */
export const search = <Row extends object, S extends Shape = Record<string, never>>(
  def: SearchDef<S, Row>,
) => {
  const page = def.page ?? {};
  const max = finiteOption('search()', 'page.max', page.max ?? DEFAULT_PAGE_MAX);
  const shape = {
    ...((def.input ?? {}) as S),
    q: termSchema(finiteOption('search()', 'termMax', def.termMax ?? DEFAULT_TERM_MAX)),
    limit: limitSchema(
      max,
      Math.min(finiteOption('search()', 'page.default', page.default ?? DEFAULT_PAGE_SIZE), max),
    ),
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
      return onePage(from<Row>(name, rows).raw('full-text search'), name, parsed.limit);
    },
  });
};
