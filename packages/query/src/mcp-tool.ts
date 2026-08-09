/**
 * A query as an MCP read tool. Its `read` goes through `sourceFor` — the same
 * authorized front half the HTTP read and the live subscription use — so the tool
 * cannot drift from the endpoint and cannot acquire a second authz path.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import type { JsonSchema } from '@ultimat3/schema';
import { toMcpInputSchema } from '@ultimat3/schema';
import { toToolName } from './naming';
import type { QueryPolicy } from './policy-gate';
import type { AnyQuery } from './query';
import { queryName, sourceFor } from './read';
import { listQueries } from './registry';

export interface QueryToolReadOptions {
  readonly ctx?: Ctx;
  /** The agent behind the call. `null` is the signed-out caller. */
  readonly actor?: Actor | null;
}

export interface QueryToolDescriptor {
  readonly name: string;
  /** The query's `mcp.description`, or its name when the author gave none. */
  readonly description: string;
  readonly query: string;
  /**
   * The query's own policy object, not a copy — `tool().policy === query.policy`
   * is what makes "an MCP call cannot reach a different authz path" checkable.
   */
  readonly policy: QueryPolicy;
  readonly inputSchema: JsonSchema;
  /** Always false: a query reads. Drives the rate-limit bucket in @ultimat3/mcp. */
  readonly mutates: false;
  read(input: unknown, options?: QueryToolReadOptions): Promise<readonly object[]>;
}

export function toQueryTool(target: AnyQuery): QueryToolDescriptor {
  const name = queryName(target);
  return {
    name: toToolName(name),
    description: target.mcp?.description ?? name,
    query: name,
    policy: target.policy,
    inputSchema: toMcpInputSchema(target.input),
    mutates: false,
    read: async (input, options = {}) => {
      // Executed without the cache tiers on purpose: an agent diffing two tool
      // calls must be reading the rows, not a TTL.
      const source = await sourceFor(target, input, {
        ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
        ...(options.actor === undefined ? {} : { actor: options.actor }),
      });
      return source.execute();
    },
  };
}

/**
 * Opt-in, unlike an action's tool: a read hands rows to an agent, so silence
 * exposes nothing. `mcp: { expose: true }` is the whole opt-in.
 */
export function isExposed(target: AnyQuery): boolean {
  return target.mcp?.expose === true;
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
