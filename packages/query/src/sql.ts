/**
 * SQL transparency. An agent that can read the SQL a query generates can fix a
 * slow or wrong read by itself; a query builder that hides its output forces it
 * to guess. `explain` is the read path for `/_x` and for `x db explain`.
 */
import type { Ctx } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { AnyQuery, Query } from './query';
import { queryName, sourceFor } from './query';
import { listQueries } from './registry';
import type { QueryShape } from './shape';
import type { SqlText } from './source';

export interface ExplainResult extends SqlText {
  readonly query: string;
  readonly shape: QueryShape;
  readonly live: boolean;
}

/**
 * Policy is deliberately NOT enforced here: `explain` never returns rows, and the
 * surfaces that expose it (`/_x`, the CLI) are admin-gated in their own right.
 */
export async function explain<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  input: unknown,
  ctx?: Ctx,
): Promise<ExplainResult> {
  const source = await sourceFor(target, input, {
    enforce: false,
    ...(ctx === undefined ? {} : { ctx }),
  });
  const text = source.toSQL();
  return {
    query: queryName(target),
    sql: text.sql,
    params: text.params,
    shape: source.shape(),
    live: target.live,
  };
}

export interface QuerySqlInfo {
  readonly query: string;
  readonly live: boolean;
  /** `null` when no sample input was supplied — SQL depends on arguments. */
  readonly sql: string | null;
}

/**
 * Dashboard listing. Pass sample inputs keyed by query name to get real SQL;
 * without one, the entry is listed with `sql: null` rather than a guess.
 */
export async function describeSql(
  samples: Readonly<Record<string, unknown>> = {},
  queries: readonly AnyQuery[] = listQueries(),
  ctx?: Ctx,
): Promise<readonly QuerySqlInfo[]> {
  const entries: QuerySqlInfo[] = [];
  for (const target of queries) {
    const name = queryName(target);
    const sample = samples[name];
    if (sample === undefined) {
      entries.push({ query: name, live: target.live, sql: null });
      continue;
    }
    const source = await sourceFor(target, sample, {
      enforce: false,
      ...(ctx === undefined ? {} : { ctx }),
    });
    entries.push({ query: name, live: target.live, sql: source.toSQL().sql });
  }
  return entries;
}
