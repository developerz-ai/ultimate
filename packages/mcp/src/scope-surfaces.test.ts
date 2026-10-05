// One `scopes` map, two doors: `bearerMount` (`/v1/*`) and `defineAppMcp` take the same map by
// design, so a token must reach the same primitives through either. They disagreed on the case
// that matters: a primitive the map leaves out was served to NOBODY on the mount and to EVERY
// token over MCP. This file drives both real surfaces with the same tokens and compares the sets.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  action,
  listActions,
  registerAction,
  resetRegistry as resetActions,
  toRoute,
} from '@ultimat3/action';
import { agentActor, createContext, runWithContext } from '@ultimat3/core';
import {
  bearerMount,
  createPipeline,
  createRouter,
  defineHttpConfig,
  mountedPath,
} from '@ultimat3/http';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpScopes } from './scopes';

const NAMES = ['archiveOrder', 'deleteAccount', 'refundOrder'] as const;

/** Every token this file holds, by the scopes it was issued. */
const TOKENS: Readonly<Record<string, readonly string[]>> = {
  'tok-none': [],
  'tok-read': ['orders:read'],
  'tok-write': ['orders:write'],
  'tok-all': ['orders:read', 'orders:write', 'account:admin'],
};

const owner = agentActor({ id: 'agent-1', orgId: 'o1', roles: ['owner'] });

const resolveToken = (token: string) => {
  const scopes = TOKENS[token];
  return scopes === undefined ? null : { actor: owner, scopes: new Set(scopes) };
};

/** What the bearer mount serves this token: every primitive whose `/v1` path is not a 404. */
const bearerReach = async (scopes: McpScopes, token: string): Promise<readonly string[]> => {
  const api = listActions().map(toRoute);
  const pipeline = createPipeline({
    table: createRouter([
      ...api,
      ...bearerMount({ prefix: '/v1', routes: api, scopes, resolveToken }),
    ]),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  });
  const reached: string[] = [];
  for (const name of NAMES) {
    // The path the mount derives, not a spelling of it: an action's path is its own business.
    const path = mountedPath('/v1', api.find((route) => route.meta.name === name)?.path ?? '');
    const response = await pipeline.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{}',
      }),
      { role: 'web' },
    );
    if (response.status !== 404) {
      expect(response.status).toBe(200);
      reached.push(name);
    }
  }
  return reached;
};

/** What the MCP server runs for this token: every tool whose call is not refused by a gate. */
const mcpReach = async (scopes: McpScopes, token: string): Promise<readonly string[]> => {
  const { server } = defineAppMcp({ include: 'exposed', scopes });
  const caller = { ...(resolveToken(token) ?? { actor: owner, scopes: new Set<string>() }) };
  const reached: string[] = [];
  for (const name of NAMES) {
    const response = await runWithContext(createContext({}), () =>
      server.handle(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
        caller,
      ),
    );
    const result = response?.result as { isError?: boolean } | undefined;
    if (response?.error === undefined && result?.isError !== true) reached.push(name);
  }
  return reached;
};

describe('one scopes map exposes one set through bearerMount and defineAppMcp', () => {
  beforeEach(() => {
    definePermissions(['order:manage']);
    defineRoles({ owner: { grants: ['order:manage'] } });
    for (const name of NAMES) {
      registerAction(
        name,
        action({
          input: t.object({}),
          output: t.object({ ok: t.boolean }),
          policy: can('order:manage'),
          mcp: { expose: true, description: name },
          handle: () => ({ ok: true }),
        }),
      );
    }
  });

  afterEach(() => {
    resetActions();
    clearPermissions();
    clearRoles();
  });

  test('a map covering every primitive: each token reaches the same primitives on both', async () => {
    const scopes: McpScopes = {
      'orders:read': ['archiveOrder'],
      'orders:write': ['refundOrder'],
      'account:admin': ['deleteAccount'],
    };
    for (const token of Object.keys(TOKENS)) {
      expect({ token, reach: await mcpReach(scopes, token) }).toEqual({
        token,
        reach: await bearerReach(scopes, token),
      });
    }
    // And the sets are the ones the map says — not two equally wrong answers.
    expect(await mcpReach(scopes, 'tok-read')).toEqual(['archiveOrder']);
    expect(await mcpReach(scopes, 'tok-none')).toEqual([]);
  });

  test('a map leaving a primitive out: the mount serves it to nobody, and MCP refuses to boot', async () => {
    const scopes: McpScopes = {
      'orders:read': ['archiveOrder'],
      'orders:write': ['refundOrder'],
    };
    // The mount fails closed: an unlisted primitive is not mounted at all.
    expect(await bearerReach(scopes, 'tok-all')).toEqual(['archiveOrder', 'refundOrder']);
    // MCP cannot match that by hiding a tool `include: 'exposed'` asked for, so it refuses the
    // declaration — before, it booted and `deleteAccount` answered every token.
    expect(() => defineAppMcp({ include: 'exposed', scopes })).toThrow(
      expect.objectContaining({ code: 'X_MCP_SCOPE_UNCOVERED' }),
    );
  });
});
