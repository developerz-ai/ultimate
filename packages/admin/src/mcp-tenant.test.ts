// The MCP caller's TENANT must reach every `AdminAuthz` decision, on both hops.
//
// `resolveToken` mints the `Actor` the transport carries and `adminActorOf` rebuilds the
// `AdminActor` from it; each dropped `orgId`, so over `POST /mcp` every decision was evaluated
// with `actor.orgId === undefined` while the UI path — `AdminApp.ctx({ actor })` with the app's
// own resolved actor — saw the real one. An org-scoped rule cannot fire on an actor with no org,
// and `adminList`/`adminSearch` add no tenant predicate of their own.
//
// Driven through `route.handle`, the real `POST /mcp`, because the first hop is inside it.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { defineAdmin } from './admin';
import { type AdminActor, type AdminAuthz, type AdminDecision, staticAuthz } from './authz';
import { adminMcp } from './mcp';
import type { AdminRow } from './registry';

const doc = entity('admin_tenant_doc', {
  columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
});

afterAll(clearRegistry);

/** Every `orgId` an authz decision was handed, in order. `undefined` is the defect. */
const seen: (string | undefined)[] = [];

const GRANTS: readonly string[] = ['admin:read', 'admin_tenant_doc:read'];

const recordingAuthz: AdminAuthz = {
  decide(query): AdminDecision {
    seen.push(query.actor.orgId);
    return staticAuthz(GRANTS).decide(query);
  },
};

const app = defineAdmin({
  entities: [doc],
  resources: {
    admin_tenant_doc: {
      repo: {
        list: async (): Promise<readonly AdminRow[]> => [],
        find: async (): Promise<AdminRow | null> => null,
        create: async (input): Promise<AdminRow> => input,
        update: async (_id, patch): Promise<AdminRow> => patch,
        destroy: async (): Promise<void> => undefined,
      },
    },
  },
  auth: { actor: (): AdminActor | null => null, authz: recordingAuthz },
});

const mcp = adminMcp({
  app,
  // The session's own resolver — the same hook the HTTP surface uses. It answers a TENANTED
  // operator, which is the fact the two hops below have to preserve.
  actor: (): AdminActor => ({ id: 'agent-1', roles: ['ops'], orgId: 'org-a' }),
  requestId: (): string => 'req_tenant',
});

const post = async (body: unknown): Promise<void> => {
  const route = mcp.route;
  if (route === undefined) expect.unreachable('adminMcp always declares a resolveToken');
  await route.handle(
    new Request('https://app.test/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer agent-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

describe("the MCP caller's tenant survives both hops", () => {
  test('every decision over tools/call sees the org the token resolved to', async () => {
    seen.length = 0;
    await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'admin.admin_tenant_doc.list', arguments: {} },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(['org-a']);
  });

  test('and so does every decision the per-caller catalog makes', async () => {
    seen.length = 0;
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(['org-a']);
  });
});
