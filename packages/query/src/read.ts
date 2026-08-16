/**
 * The one read path: parse input, evaluate policy, build the source, execute it.
 * The declaration lives in this module's private store, so `sql` is unreachable
 * from anywhere else — HTTP, MCP, live, pagination and `.as()` hand `sourceFor` a
 * payload, and none of them can become a second read path or a second authz path.
 */

import type { Ctx } from '@ultimat3/core';
import {
  anonymousActor,
  createContext,
  runWithContext,
  tryUseContext,
  useContext,
  withChildContext,
  withSpan,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { formatPath, validateAsync } from '@ultimat3/schema';
import { cacheKeyFor, readFresh, readOnce, readThrough } from './cache';
import { QueryForeignError, QueryInputInvalidError, QueryUnregisteredError } from './errors';
import { actorOf, guard } from './policy-gate';
import type { AnyQuery, AnyQueryDef, Query, QueryOptions, SourceOptions } from './query';
import { DEFAULT_READ_CACHE_TTL_MS } from './read-cache';
import type { SqlSource } from './source';

/**
 * Private on purpose. `@ultimat3/query` exports no way to read this back, which is
 * what makes "the only way to reach `sql` is `sourceFor`" structural rather than a
 * rule someone has to remember.
 */
const DECLARATIONS = new WeakMap<object, AnyQueryDef>();

/** Called once per built query, by `query()` and by every rename it produces. */
export function stashDef(target: object, def: AnyQueryDef): void {
  DECLARATIONS.set(target, def);
}

/** True only for objects this package built — `isQuery` leans on it. */
export function hasDef(target: object): boolean {
  return DECLARATIONS.has(target);
}

/** Internal read of the declaration. Never re-exported from `src/index.ts`. */
export function defOf(target: AnyQuery): AnyQueryDef {
  const def = DECLARATIONS.get(target);
  if (def === undefined) throw new QueryForeignError(target.name);
  return def;
}

/** Projections need a stable name; an unregistered query has none yet. */
export function queryName(target: AnyQuery): string {
  if (target.name.length === 0) throw new QueryUnregisteredError();
  return target.name;
}

/** Validate, authorize, then read — the same three steps on every surface. */
export function runQuery<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  raw: unknown,
  options?: QueryOptions,
): Promise<readonly TRow[]>;
/**
 * The same read from a schema-erased handle. The route projection maps `listQueries()`,
 * which knows only `AnyQuery` — an overload rather than a second function, so what is
 * gone is the row TYPE and never the parse, the policy or the memo.
 */
export function runQuery(
  target: AnyQuery,
  raw: unknown,
  options?: QueryOptions,
): Promise<readonly object[]>;
export function runQuery(
  target: AnyQuery,
  raw: unknown,
  options: QueryOptions = {},
): Promise<readonly object[]> {
  return asActor(options, (ctx) => readRows(target, raw, ctx, options));
}

/**
 * Validated, authorized `SqlSource` without executing it. `live`, `paginate`,
 * `explain` and the MCP tool all build on this, so none of them re-implement the
 * front half and none of them can skip the policy while doing it.
 */
export function sourceFor(
  target: AnyQuery,
  raw: unknown,
  options: SourceOptions = {},
): Promise<SqlSource<object>> {
  return asActor(options, (ctx) => buildSource(target, raw, ctx, options));
}

/**
 * Impersonation, in one place: keep the surrounding context whole — services,
 * clock, locale, trace — and swap only the actor. Policy models "nobody" as null;
 * core models it as the anonymous actor. Omitting `actor` touches no context at all.
 */
function asActor<T>(options: QueryOptions, run: (ctx: Ctx) => Promise<T>): Promise<T> {
  if (options.actor === undefined) return run(options.ctx ?? useContext());
  const patch = { actor: options.actor ?? anonymousActor() };
  const inChild = (): Promise<T> => run(useContext());
  const base = options.ctx ?? tryUseContext();
  return base === undefined
    ? runWithContext(createContext(patch), inChild)
    : runWithContext(base, () => withChildContext(patch, inChild));
}

/**
 * The span covers the WHOLE read, not just `execute()`. Wrapping the execution alone left the
 * input parse, the policy evaluation and `sql()`'s own construction outside every span, so a read
 * whose cost was in building the source reported milliseconds while its parent HTTP span reported
 * seconds — a gap with no name, which reads as framework overhead and gets hand-instrumented.
 *
 * Attributes are bounded: surface, actor KIND, booleans, and a row count. Never the input, never
 * an actor id — a read is keyed per tenant and per cursor, and either would be unbounded.
 */
function readRows(
  target: AnyQuery,
  raw: unknown,
  ctx: Ctx,
  options: QueryOptions,
): Promise<readonly object[]> {
  const name = queryName(target);
  return withSpan(`query.${name}`, async (span) => {
    span.setAttributes({
      'ultimate.primitive': 'query',
      'ultimate.query': name,
      'ultimate.surface': options.surface ?? 'server',
      'ultimate.actor.kind': ctx.actor.kind,
      'ultimate.live': target.isLive,
      'ultimate.fresh': options.fresh === true,
      // Whether this read goes through the tier at all. Every read is memoized; only a `cache:`
      // read is filled — and which of the two a slow read took is the first thing to ask.
      'ultimate.cached': defOf(target).cache !== undefined,
    });
    const rows = await readRowsIn(target, raw, ctx, options);
    span.setAttribute('ultimate.rows', rows.length);
    return rows;
  });
}

async function readRowsIn(
  target: AnyQuery,
  raw: unknown,
  ctx: Ctx,
  options: QueryOptions,
): Promise<readonly object[]> {
  const def = defOf(target);
  const name = queryName(target);
  const source = await buildSource(target, raw, ctx, options);
  const read = (): Promise<readonly object[]> => source.execute();
  // The source came from this query's own `sql()`, so its rows are TRow throughout —
  // which is what the typed overload above states, and this body never has to assert.
  const tags = def.cache?.tags ?? [];
  const key = cacheKeyFor(name, raw, tags);
  // `fresh` is the caller saying no cache may answer this one — the memo included, a memo being
  // a cache whose lifetime is the request. It still *publishes* into the memo: this read is the
  // newest answer the request has, so the next plain read of the key joins it rather than the
  // entry a write earlier in the request already moved past.
  if (options.fresh === true) return await readFresh(ctx, key, read);
  // `cache:` buys the tier, never the memo: a read asked twice in one request is one execution
  // whether or not its author opted into caching.
  // A declared `cache:` with no `ttlMs` gets one anyway. Tags are the primary eviction, but a
  // read whose tags never fire would otherwise hold one entry per distinct input for the life of
  // the process — a paginated feed over 10k tenants is 10k immortal entries.
  return def.cache === undefined
    ? await readOnce(ctx, key, read)
    : await readThrough(ctx, key, def.cache.ttlMs ?? DEFAULT_READ_CACHE_TTL_MS, read, tags);
}

async function buildSource(
  target: AnyQuery,
  raw: unknown,
  ctx: Ctx,
  options: SourceOptions,
): Promise<SqlSource<object>> {
  const def = defOf(target);
  const name = queryName(target);
  const input = await validate(def.input, raw, name);
  if (options.enforce !== false) {
    guard(
      def.policy,
      { actor: actorOf(ctx), input, ctx, query: name },
      options.surface ?? 'server',
    );
  }
  const source = def.sql(input, ctx);
  // A live window is served in the order its patches are placed in. The matcher breaks a tie on
  // the declared keys with `id` (`totalOrder`) and so does the keyset re-read a reconnect resumes
  // with, so an initial window served in the declared keys alone puts tied rows where neither of
  // them would: the client renders one order and the next read answers another. A source that
  // cannot say (`total` absent) already serves one order it can be resumed in.
  return options.surface === 'live' && source.total !== undefined ? source.total() : source;
}

async function validate(schema: StandardSchemaV1, raw: unknown, name: string): Promise<unknown> {
  const result = await validateAsync(schema, raw);
  if (result.issues !== undefined) {
    const detail = result.issues
      .map((issue) => {
        const path = formatPath(issue.path);
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new QueryInputInvalidError(name, detail);
  }
  return result.value;
}
