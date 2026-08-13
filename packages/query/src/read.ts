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
import { cacheKeyFor, readOnce, readThrough } from './cache';
import { QueryForeignError, QueryInputInvalidError, QueryUnregisteredError } from './errors';
import { actorOf, guard } from './policy-gate';
import type { AnyQuery, AnyQueryDef, Query, QueryOptions, SourceOptions } from './query';
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
  options: QueryOptions = {},
): Promise<readonly TRow[]> {
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

async function readRows<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  raw: unknown,
  ctx: Ctx,
  options: QueryOptions,
): Promise<readonly TRow[]> {
  const def = defOf(target);
  const name = queryName(target);
  const source = await buildSource(target, raw, ctx, options);
  const read = (): Promise<readonly object[]> => withSpan(`query.${name}`, () => source.execute());
  // The source came from this query's own `sql()`, so its rows are TRow throughout.
  // `fresh` is the caller saying no cache may answer this one — the memo included, a memo being
  // a cache whose lifetime is the request.
  if (options.fresh === true) return (await read()) as readonly TRow[];
  // `cache:` buys the tier, never the memo: a read asked twice in one request is one execution
  // whether or not its author opted into caching.
  const key = cacheKeyFor(name, raw, def.cache?.tags ?? []);
  const rows =
    def.cache === undefined
      ? await readOnce(ctx, key, read)
      : await readThrough(ctx, key, def.cache.ttlMs ?? null, read);
  return rows as readonly TRow[];
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
  return def.sql(input, ctx);
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
