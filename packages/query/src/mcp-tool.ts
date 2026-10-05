/**
 * A query as an MCP read tool. Its `read` goes through `sourceFor` — the same
 * authorized front half the HTTP read and the live subscription use — so the tool
 * cannot drift from the endpoint and cannot acquire a second authz path.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { isMcpExposed } from '@ultimat3/core';
import type { WireJsonSchema } from '@ultimat3/schema';
import { toWireSchema } from '@ultimat3/schema';
import type { QueryPolicy } from './policy-gate';
import type { AnyQuery } from './query';
import { queryName, sourceFor } from './read';
import { listQueries } from './registry';
import { readAnswer } from './single-answer';

export interface QueryToolReadOptions {
  readonly ctx?: Ctx;
  /** The agent behind the call. `null` is the signed-out caller. */
  readonly actor?: Actor | null;
}

/**
 * What `read()` resolves to, decided by the declaration: a list read's rows, a `single: true`
 * read's one row. Only a schema-erased query (`AnyQuery`, a mixed registry) answers the union —
 * a KNOWN list read typed as "rows or a row" made `.map` on its own answer a compile error.
 */
export type QueryToolAnswer<TSingle extends boolean> = [TSingle] extends [true]
  ? object
  : [TSingle] extends [false]
    ? readonly object[]
    : readonly object[] | object;

export interface QueryToolDescriptor<TSingle extends boolean = boolean> {
  /**
   * The export name VERBATIM, and identical to `query` below. `@ultimat3/mcp` serves a read
   * under `queryName(target)` and answers `tools/call` for nothing else, so a snake_cased
   * descriptor named a tool the server had never heard of — which it did until 2026-08.
   */
  readonly name: string;
  /** The query's `mcp.description`, or its name when the author gave none. */
  readonly description: string;
  readonly query: string;
  /**
   * The query's own policy object, not a copy — `tool().policy === query.policy`
   * is what makes "an MCP call cannot reach a different authz path" checkable.
   */
  readonly policy: QueryPolicy;
  /** What `@ultimat3/mcp`'s `tools/list` serves for this read — `@ultimat3/schema`'s wire subset. */
  readonly inputSchema: WireJsonSchema;
  /** Always false: a query reads. Drives the rate-limit bucket in @ultimat3/mcp. */
  readonly mutates: false;
  /**
   * The rows — or, for a `single: true` read, the one row itself and `X_NOT_FOUND` when there is
   * none. The route's answer on both counts: an agent handed `[]` for a missing id reads "found,
   * and empty" where the same read over HTTP said 404.
   */
  read(input: unknown, options?: QueryToolReadOptions): Promise<QueryToolAnswer<TSingle>>;
}

export function toQueryTool<TSingle extends boolean = boolean>(
  target: AnyQuery & { readonly single?: TSingle },
): QueryToolDescriptor<TSingle> {
  const name = queryName(target);
  return {
    name,
    description: target.mcp?.description ?? name,
    query: name,
    policy: target.policy,
    inputSchema: toWireSchema(target.input),
    mutates: false,
    read: async (input, options = {}) => {
      // Executed without the cache tiers on purpose: an agent diffing two tool
      // calls must be reading the rows, not a TTL.
      const source = await sourceFor(target, input, {
        // An agent's call, so a declared `rateLimit:` spends for it; judged as `'server'` was.
        surface: 'mcp',
        ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
        ...(options.actor === undefined ? {} : { actor: options.actor }),
      });
      // The declaration decides the shape, and `TSingle` is that declaration as a type.
      return readAnswer(target, await source.execute()) as QueryToolAnswer<TSingle>;
    },
  };
}

/**
 * Opt-in: a read hands rows to an agent, so silence exposes nothing. `mcp: { expose: true }` is
 * the whole opt-in — `isMcpExposed` from `@ultimat3/core` is the framework's one answer, and an
 * action's tool is now decided by the same call rather than by a second, looser rule.
 */
export function isExposed(target: AnyQuery): boolean {
  return isMcpExposed(target.mcp);
}

/** Deterministic order — the tool list is part of the agent-visible contract. */
export function toQueryTools(
  queries: readonly AnyQuery[] = listQueries(),
): readonly QueryToolDescriptor[] {
  return queries
    .filter(isExposed)
    .map(toQueryTool)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
