// The MCP caller must be the AMBIENT actor for the whole call, not only the `CrudCtx` one.
//
// `AdminApp.ctx()` builds a plain `CrudCtx` and never touches core's async context, so everything
// that derives from `tryUseContext()` — entity's tenant guard, the query cache authority, the
// jit-preload store — read whatever actor the transport's surrounding request had installed. Over
// HTTP that is the session cookie's user; over stdio it is nothing at all.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { agentActor, ctxOf, runWithContext, tryUseContext, userActor } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { McpCaller } from '@ultimat3/mcp';
import type { AdminApp } from './admin';
import { defineAdmin } from './admin';
import { type AdminActor, type AdminAuthz, type AdminDecision, staticAuthz } from './authz';
import { adminMcp } from './mcp';
import { adminTokenScopes } from './mcp-scopes';
import type { AdminAction, AdminRow } from './registry';

const doc = entity('admin_ctx_doc', {
  columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
});

afterAll(clearRegistry);

/** What the ambient context looked like INSIDE the tool call. `null` = there was none. */
let seenActorId: string | null | undefined;
let seenActorKind: string | null | undefined;

const whoami: AdminAction = {
  name: 'doc.whoami',
  permission: 'admin_ctx_doc:publish',
  entity: 'admin_ctx_doc',
  mcp: { expose: true, description: 'Report the ambient actor' },
  handle(): Promise<unknown> {
    const ctx = tryUseContext();
    seenActorId = ctx === undefined ? null : (ctx.actor?.id ?? null);
    seenActorKind = ctx === undefined ? null : (ctx.actor?.kind ?? null);
    return Promise.resolve({ ok: true });
  },
};

const GRANTS: Record<string, readonly string[]> = {
  agent: ['admin:read', 'admin:write', 'admin_ctx_doc:read', 'admin_ctx_doc:publish'],
};

const perActorAuthz: AdminAuthz = {
  decide(query): AdminDecision {
    return staticAuthz(GRANTS[query.actor.id] ?? []).decide(query);
  },
};

let app: AdminApp;
let mcp: ReturnType<typeof adminMcp>;
beforeAll(() => {
  app = defineAdmin({
    entities: [doc],
    actions: [whoami],
    resources: {
      admin_ctx_doc: {
        repo: {
          list: async (): Promise<readonly AdminRow[]> => [],
          // A row to act on: an action on a row nobody can find is refused before its handler.
          find: async (id): Promise<AdminRow | null> => ({ id }),
          create: async (input): Promise<AdminRow> => input,
          update: async (_id, patch): Promise<AdminRow> => patch,
          destroy: async (): Promise<void> => undefined,
        },
      },
    },
    auth: { actor: (): AdminActor | null => null, authz: perActorAuthz },
  });
  mcp = adminMcp({
    app,
    actor: (): AdminActor | null => null,
    requestId: (): string => 'req_ctx',
  });
});

const caller: McpCaller = {
  actor: agentActor({ id: 'agent' }),
  scopes: adminTokenScopes(undefined),
};

const callWhoami = async (): Promise<void> => {
  seenActorId = undefined;
  seenActorKind = undefined;
  await mcp.server.handle(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'admin.action.doc.whoami', arguments: { id: 'doc-1' } },
    },
    caller,
  );
};

describe('the MCP caller is the ambient actor for the whole call', () => {
  test('with no surrounding request, the call still runs under the token actor', async () => {
    // The stdio case. There was no context at all, so `actorTenant` answered `undefined` and
    // entity's `assertRowTenant` became a no-op — an admin `create` could name any `orgId`.
    await callWhoami();
    expect(seenActorId).toBe('agent');
    expect(seenActorKind).toBe('agent');
  });

  test("a surrounding request's actor does not survive into the tool call", async () => {
    // The HTTP case: `mcpHttpRoute` mounted in a pipeline that already resolved a session cookie.
    // The agent token authorized as the agent while the repo reads ran as the cookie user.
    await runWithContext(
      ctxOf({ actor: userActor({ id: 'cookie-user', orgId: 'org-other' }) }),
      callWhoami,
    );
    expect(seenActorId).toBe('agent');
    expect(seenActorKind).toBe('agent');
  });
});
