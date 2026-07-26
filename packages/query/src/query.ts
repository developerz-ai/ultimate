/**
 * The `query` primitive: a policy-checked read, optionally live. Row types are
 * inferred from the `SqlSource` the `sql:` function returns, so a component gets
 * the real row shape without a second declaration.
 */

import type { CacheTag } from '@ultimat3/cache';
import type { Ctx } from '@ultimat3/core';
import { useContext, withSpan } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatPath, validateAsync } from '@ultimat3/schema';
import { cacheKeyFor, readThrough } from './cache';
import { QueryInputInvalidError, QueryUnregisteredError } from './errors';
import type { QueryPolicy, QuerySurface } from './policy-gate';
import { actorOf, guard, policyCapability } from './policy-gate';
import type { SqlSource } from './source';
import { fingerprint } from './stable';
import { tagKeys } from './tags';

export interface QueryCache {
  /** Tags this read depends on. An action's `invalidates` drops exactly these keys. */
  readonly tags: readonly CacheTag[];
  readonly ttlMs?: number;
}

export interface QueryDef<TInput extends StandardSchemaV1, TRow extends object> {
  readonly input: TInput;
  readonly policy: QueryPolicy;
  /** `true` makes the read subscribable — see `toLiveQuery`. */
  readonly live?: boolean;
  sql(input: InferOutput<TInput>, ctx: Ctx): SqlSource<TRow>;
  readonly cache?: QueryCache;
}

export interface QueryOptions {
  readonly ctx?: Ctx;
  readonly surface?: QuerySurface;
  /** Skips the cache tiers for this call. Live fanout always reads fresh. */
  readonly fresh?: boolean;
}

export interface QueryDescriptor {
  readonly kind: 'query';
  readonly name: string;
  readonly live: boolean;
  readonly capability: string;
  readonly tags: readonly string[];
  readonly ttlMs: number | null;
}

/**
 * Schema-erased view. Everything that only *describes* a query (registry, sql
 * explain, live descriptor, manifest) takes this, so a concrete `Query<In, Row>`
 * passes without variance gymnastics. Method syntax is load-bearing: bivariant
 * parameters are what make the erasure assignable.
 */
export interface AnyQueryDef {
  readonly input: StandardSchemaV1;
  readonly policy: QueryPolicy;
  readonly live?: boolean;
  sql(input: unknown, ctx: Ctx): SqlSource<object>;
  readonly cache?: QueryCache;
}

export interface AnyQuery {
  readonly kind: 'query';
  readonly name: string;
  readonly live: boolean;
  readonly def: AnyQueryDef;
  describe(): QueryDescriptor;
  named(name: string): AnyQuery;
}

export interface Query<
  TInput extends StandardSchemaV1 = StandardSchemaV1,
  TRow extends object = Record<string, unknown>,
> extends AnyQuery {
  (input: InferInput<TInput>, options?: QueryOptions): Promise<readonly TRow[]>;
  readonly def: QueryDef<TInput, TRow>;
  named(name: string): Query<TInput, TRow>;
}

export function query<TInput extends StandardSchemaV1, TRow extends object>(
  def: QueryDef<TInput, TRow>,
): Query<TInput, TRow> {
  return build(def, '');
}

export function isQuery(value: unknown): value is AnyQuery {
  return typeof value === 'function' && (value as { kind?: unknown }).kind === 'query';
}

function build<TInput extends StandardSchemaV1, TRow extends object>(
  def: QueryDef<TInput, TRow>,
  name: string,
): Query<TInput, TRow> {
  const callable = (
    input: InferInput<TInput>,
    options: QueryOptions = {},
  ): Promise<readonly TRow[]> => runQuery(self, input, options);

  const self: Query<TInput, TRow> = Object.assign(callable, {
    kind: 'query' as const,
    live: def.live === true,
    def,
    describe: (): QueryDescriptor => ({
      kind: 'query',
      name: queryName(self),
      live: def.live === true,
      capability: policyCapability(def.policy),
      tags: tagKeys(def.cache?.tags ?? []),
      ttlMs: def.cache?.ttlMs ?? null,
    }),
    named: (next: string): Query<TInput, TRow> => build(def, next),
  });
  Object.defineProperty(self, 'name', { value: name, configurable: true });
  return self;
}

/** Validate, authorize, then read — the same three steps on every surface. */
export async function runQuery<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  raw: unknown,
  options: QueryOptions = {},
): Promise<readonly TRow[]> {
  const name = queryName(target);
  const ctx = options.ctx ?? useContext();
  const source = await sourceFor(target, raw, options);
  const key = cacheKeyFor(name, raw, target.def.cache?.tags ?? []);
  const read = (): Promise<readonly object[]> => withSpan(`query.${name}`, () => source.execute());
  // The source came from this query's own `sql()`, so its rows are TRow.
  if (options.fresh === true || target.def.cache === undefined) {
    return (await read()) as readonly TRow[];
  }
  const rows = await readThrough(ctx, key, target.def.cache.ttlMs ?? null, read);
  return rows as readonly TRow[];
}

export interface SourceOptions extends QueryOptions {
  /** `false` only for developer tooling (`explain`), which is admin-gated. */
  readonly enforce?: boolean;
}

/**
 * Validated, authorized `SqlSource` without executing it. `live`, `paginate` and
 * `explain` all build on this so none of them re-implement the front half.
 */
export async function sourceFor(
  target: AnyQuery,
  raw: unknown,
  options: SourceOptions = {},
): Promise<SqlSource<object>> {
  const name = queryName(target);
  const ctx = options.ctx ?? useContext();
  const input = await validate(target, raw);
  if (options.enforce !== false) {
    const subject = { actor: actorOf(ctx), input, ctx, query: name };
    guard(target.def.policy, subject, options.surface ?? 'server');
  }
  return target.def.sql(input, ctx);
}

async function validate(target: AnyQuery, raw: unknown): Promise<unknown> {
  const result = await validateAsync(target.def.input, raw);
  if (result.issues !== undefined) {
    const detail = result.issues
      .map((issue) => {
        const path = formatPath(issue.path);
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new QueryInputInvalidError(queryName(target), detail);
  }
  return result.value;
}

/** Stable identity of a query + its arguments. Used for cursors and live keys. */
export function queryHash(name: string, input: unknown): string {
  return `${name}:${fingerprint(input)}`;
}

export function queryName(target: AnyQuery): string {
  if (target.name.length === 0) throw new QueryUnregisteredError();
  return target.name;
}
