// The admin judges the actor the app's policy was written for: an agent stays an agent, its
// scopes and an impersonation's `onBehalfOf` survive every crossing — the UI's request actor, the
// MCP caller, and a queued batch chunk the worker re-runs. A rule refusing agents fires here too.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Actor,
  agentActor,
  ctxOf,
  runWithContext,
  useContext,
  userActor,
} from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { type JobDriver, jobWorker, memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import { can, definePermissions, denied, type Policy } from '@ultimat3/policy';
import { adminActorFrom } from './actor';
import { defineAdmin } from './admin';
import type { AdminActor } from './authz';
import { adminMcp } from './mcp';
import { callAdminTool } from './mcp-dispatch';
import { policyAuthz } from './policy-bridge';
import type { AdminAction, AdminRow } from './registry';

const kind_docs = entity('admin_kind_docs', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }) },
});
const db = database({ kind_docs }, { driver: memoryDriver() });

const PERMS = [
  'admin:read',
  'admin:write',
  'admin:destroy',
  'admin_kind_docs:read',
  'admin_kind_docs:write',
  'admin_kind_docs:delete',
] as const;

/** Every actor the app's policy was handed, as it saw it. */
const seen: Actor[] = [];
const destroyed: string[] = [];
/** The ambient actor a queued chunk's handler ran under. */
const ambient: string[] = [];

/** "Agents may never delete": the rule the app writes once, for every surface. */
const noAgents = (permission: (typeof PERMS)[number]): Policy =>
  can(permission as never, ({ actor }) => {
    if (actor !== undefined && actor !== null) seen.push(actor as Actor);
    return actor?.kind === 'agent' ? denied('agents may not delete') : true;
  });
/** Records the actor and allows: the probe for what reaches a policy. */
const recording = (permission: (typeof PERMS)[number]): Policy =>
  can(permission as never, ({ actor }) => {
    if (actor !== undefined && actor !== null) seen.push(actor as Actor);
    return true;
  });

const archive: AdminAction = {
  name: 'doc.archive',
  permission: 'admin_kind_docs:write',
  entity: 'admin_kind_docs',
  batch: { threshold: 1, chunk: 1 },
  handle: async () => {
    ambient.push(useContext().actor.kind);
  },
};

const repo = {
  list: async (): Promise<readonly AdminRow[]> => [{ id: 'd1', title: 'x' }],
  find: async (id: unknown): Promise<AdminRow | null> => ({ id: String(id), title: 'x' }),
  create: async (input: AdminRow): Promise<AdminRow> => input,
  update: async (_id: unknown, patch: AdminRow): Promise<AdminRow> => patch,
  destroy: async (id: unknown): Promise<void> => {
    destroyed.push(String(id));
  },
};

const authz = () =>
  policyAuthz({
    policies: {
      'admin_kind_docs:delete': noAgents('admin_kind_docs:delete'),
      'admin:destroy': noAgents('admin:destroy'),
      'admin_kind_docs:write': recording('admin_kind_docs:write'),
      'admin_kind_docs:read': recording('admin_kind_docs:read'),
    },
  });

let jobs: JobDriver;
beforeAll(() => {
  definePermissions([...PERMS]);
  jobs = memoryJobDriver();
  installJobDriver(jobs);
});
afterAll(async () => {
  resetJobDriver();
  await jobs.close?.();
  clearRegistry();
});

const agentAdmin: AdminActor = {
  id: 'agent-1',
  roles: [],
  permissions: [...PERMS],
};

describe('unit · the MCP caller is judged as the agent it is', () => {
  test('a policy refusing agents refuses the admin MCP delete', async () => {
    seen.length = 0;
    destroyed.length = 0;
    const app = defineAdmin({
      basePath: '/kind-mcp',
      entities: [kind_docs],
      resources: { admin_kind_docs: { repo } },
      auth: { actor: (): AdminActor | null => null, authz: authz() },
    });
    const mcp = adminMcp({
      app,
      actor: () => ({ ...agentAdmin, scopes: ['tenancy:cross'] }),
      requestId: () => 'req',
    });
    const route = mcp.route;
    if (route === undefined) expect.unreachable('adminMcp mounted no route');
    await route.handle(
      new Request('https://app.test/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'admin.admin_kind_docs.delete',
            arguments: { id: 'd1', confirmation: 'admin_kind_docs:d1' },
          },
        }),
      }),
    );
    expect(destroyed).toEqual([]);
    expect(new Set(seen.map((actor) => actor.kind))).toEqual(new Set(['agent']));
    // The app's framework scopes ride to the policy too: a scope-checking rule can fire.
    expect(seen.every((actor) => actor.scopes.includes('tenancy:cross'))).toBe(true);
  });
});

describe('unit · the request actor crosses whole', () => {
  test('scopes and onBehalfOf reach the policy; the kind is kept', () => {
    seen.length = 0;
    const origin = { actorId: 'staff-9', actorKind: 'user' } as const;
    const impersonated = userActor({
      id: 'u-1',
      permissions: [...PERMS],
      scopes: ['tenancy:cross'],
      onBehalfOf: origin,
    });
    const actor = adminActorFrom(impersonated, 'en', 'UTC');
    if (actor === null) expect.unreachable('a signed-in actor became anonymous');
    expect(actor).toMatchObject({ kind: 'user', scopes: ['tenancy:cross'], onBehalfOf: origin });
    const decision = authz().decide({ permission: 'admin_kind_docs:read', actor });
    expect(decision.allowed).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      kind: 'user',
      scopes: ['tenancy:cross'],
      onBehalfOf: origin,
    });
  });

  test('an agent request actor is refused by the agent rule', () => {
    const actor = adminActorFrom(agentActor({ id: 'a', permissions: [...PERMS] }), 'en', 'UTC');
    if (actor === null) expect.unreachable('a signed-in actor became anonymous');
    expect(authz().decide({ permission: 'admin_kind_docs:delete', actor }).allowed).toBe(false);
  });

  test('an AdminActor with no kind is a user, as every hand-built one before it was', () => {
    seen.length = 0;
    authz().decide({ permission: 'admin_kind_docs:read', actor: agentAdmin });
    expect(seen.at(-1)?.kind).toBe('user');
  });
});

describe('unit · a queued batch chunk runs as the agent that queued it', () => {
  test('the worker judges and runs the chunk as an agent, never a user', async () => {
    seen.length = 0;
    ambient.length = 0;
    const app = defineAdmin({
      basePath: '/kind-batch',
      entities: [kind_docs],
      db,
      actions: [archive],
      auth: { authz: authz() },
    });
    const id = String((await db.kind_docs.insert({ title: 'q' })).id);
    const other = String((await db.kind_docs.insert({ title: 'r' })).id);
    const ctx = app.ctx({ actor: { ...agentAdmin, kind: 'agent' }, requestId: 'batch' });
    const queued = await callAdminTool(app, ctx, 'admin.action.doc.archive', { ids: [id, other] });
    expect(queued).toMatchObject({ ok: true, data: { queued: 2 } });
    seen.length = 0;
    const worker = jobWorker({
      driver: jobs,
      context: () => ctxOf({ role: 'worker' }),
      drainOnShutdown: false,
    });
    await runWithContext(ctxOf({ role: 'worker' }), async () => {
      await worker.tick();
      await worker.tick();
    });
    await worker.stop('test');
    expect(ambient).toEqual(['agent', 'agent']);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((actor) => actor.kind))).toEqual(new Set(['agent']));
  });
});
