// The two rulings on a `tenant` server the #1033 security review asked for, pinned. (1) The token's
// scopes and MCP role carry into every tenant unchanged; the per-tenant authority is the actor the
// app's `resolve` answers, which REPLACES the person's — so a narrowing `resolve` narrows. (2) Only
// `tools/call` names a tenant: `resources/read` runs as the person, in no tenant, and a tenant read
// there fails closed at the entity tenancy guard.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asCallerContext } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import { scopedPlan } from '@ultimat3/entity';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';
import type { McpTenant } from './tenant';
import type { JsonRpcResponse } from './wire';

const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const read = (params: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'resources/read',
  params,
});
const textOf = (response: JsonRpcResponse | null): string =>
  ((response?.result as { content?: { text: string }[] } | undefined)?.content ?? [])[0]?.text ??
  '';
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

/** Owner of acme, reader of gamma — and an owner in its own right, which must not leak into gamma. */
const ROLES = new Map([
  ['acme', 'owner'],
  ['gamma', 'reader'],
]);
const person: McpCaller = {
  actor: agentActor({ id: 'p_ada', roles: ['owner'] }),
  scopes: new Set(['org:write']),
};

let resolveCalls = 0;
const tenant: McpTenant = {
  arg: 'project',
  resolve: ({ person: who, value }): Actor | null => {
    resolveCalls += 1;
    const role = ROLES.get(value);
    return role === undefined ? null : agentActor({ id: who.id, orgId: value, roles: [role] });
  },
  list: () => [...ROLES.keys()].map((value) => ({ value })),
};

let wrote: unknown[] = [];
let readAs: McpCaller[] = [];
const server = () =>
  defineAppMcp({
    tenant,
    scopes: { 'org:write': ['rename'], 'org:audit': ['auditLog'] },
    tools: {
      rename: {
        description: 'Rename the acting org.',
        input: t.object({}),
        policy: 'org:write',
        handle: ({ ctx }) => {
          wrote.push(ctx.actor.orgId);
          return { renamed: ctx.actor.orgId };
        },
      },
      auditLog: {
        description: 'The acting org’s audit log. Read-only.',
        input: t.object({}),
        policy: 'org:read',
        destructive: false,
        handle: () => ({ ok: true }),
      },
    },
    resources: [
      {
        uri: 'app://org/invoices',
        name: 'invoices',
        description: 'The acting org’s invoices.',
        mimeType: 'application/json',
        // A tenant read, as an app writes one: the entity guard under the caller it was handed.
        read: (caller) => {
          readAs.push(caller);
          const plan = asCallerContext(caller.actor, () =>
            scopedPlan('Invoice', 'orgId', 'findMany', {
              entity: 'Invoice',
              where: [],
              orderBy: [],
              limit: 50,
            }),
          );
          return JSON.stringify(plan.where);
        },
      },
    ],
  }).server;

beforeEach(() => {
  wrote = [];
  readAs = [];
  resolveCalls = 0;
  definePermissions(['org:read', 'org:write']);
  defineRoles({ owner: { grants: ['org:read', 'org:write'] }, reader: { grants: ['org:read'] } });
});
afterEach(() => {
  clearPermissions();
  clearRoles();
});

describe('a narrowing resolve takes effect', () => {
  test('the person’s own role does not carry: in gamma the actor resolve answered decides', async () => {
    const mcp = server();
    const acme = await inRequest(() => mcp.handle(call('rename', { project: 'acme' }), person));
    const gamma = await inRequest(() => mcp.handle(call('rename', { project: 'gamma' }), person));
    expect(textOf(acme)).toBe('{"renamed":"acme"}');
    // The person holds `owner` and the token holds `org:write`; resolve answered `reader` for
    // gamma, and that is what the policy saw. A server spreading the person's roles in would run it.
    expect(JSON.stringify(gamma)).toContain('rename denied: actor lacks org:write');
    expect(wrote).toEqual(['acme']);
  });

  test('the token’s scopes carry unchanged into every tenant: owner or not, no scope is no call', async () => {
    const mcp = server();
    for (const project of ['acme', 'gamma']) {
      const answer = await inRequest(() => mcp.handle(call('auditLog', { project }), person));
      expect(JSON.stringify(answer)).toContain('X_MCP_SCOPE_DENIED');
    }
  });
});

describe('resources/read on a tenant server names no tenant', () => {
  test('a tenant read fails closed at the entity guard, and resolve is never asked', async () => {
    const answer = await inRequest(() =>
      server().handle(read({ uri: 'app://org/invoices', project: 'acme' }), person),
    );
    expect(answer?.result).toBeUndefined();
    expect(JSON.stringify(answer?.error)).toContain('X_TENANCY_ACTOR_ORG_REQUIRED');
    expect(JSON.stringify(answer)).not.toContain('"eq"');
    // The `project` the client sent is not a tenant here: the reader got the PERSON.
    expect(resolveCalls).toBe(0);
    expect(readAs.map((caller) => [caller.tenant, caller.actor.orgId])).toEqual([
      [undefined, undefined],
    ]);
  });
});

describe('a resolve answering outside its type', () => {
  test('undefined is X_MCP_TENANT_UNRESOLVED, never a TypeError escaping the step', async () => {
    // A `Map.get` miss or a JS app's bare `return`: neither the member `null` nor an actor.
    const loose = { ...tenant, resolve: () => undefined as unknown as Actor | null };
    const mcp = defineAppMcp({
      tenant: loose,
      tools: {
        orgName: {
          description: 'The acting org. Read-only.',
          input: t.object({}),
          policy: 'org:read',
          destructive: false,
          handle: ({ ctx }) => ({ org: ctx.actor.orgId }),
        },
      },
    }).server;
    const answer = await inRequest(() => mcp.handle(call('orgName', { project: 'acme' }), person));
    expect(textOf(answer)).toContain('X_MCP_TENANT_UNRESOLVED');
  });
});
