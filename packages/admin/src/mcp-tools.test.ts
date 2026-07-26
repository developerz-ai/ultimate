import { describe, expect, test } from 'bun:test';
import { type AdminApp, defineAdmin } from './admin';
import { memoryAuditLog } from './audit';
import { type AdminActor, type AdminAuthz, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import { adminMcpTools } from './mcp-tools';
import type { AdminAction, AdminEntity } from './registry';

const post: AdminEntity = {
  name: 'post',
  columns: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'varchar', index: true },
    createdAt: { type: 'timestamptz', generated: true },
  },
};

const publish: AdminAction = {
  name: 'post.publish',
  permission: 'post:publish',
  entity: 'post',
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle(): Promise<null> {
    return null;
  },
};

const actor: AdminActor = { id: 'u_1' };

const appWith = (authz: AdminAuthz): AdminApp =>
  defineAdmin({
    entities: [post],
    actions: [publish],
    auth: { actor: (): AdminActor => actor, authz },
  });

const ctxWith = (authz: AdminAuthz): CrudCtx => ({
  actor,
  authz,
  audit: memoryAuditLog(),
  requestId: 'req_1',
});

describe('the MCP surface is the UI surface', () => {
  test('a read-only actor gets read tools and nothing that writes', () => {
    const authz = staticAuthz(['admin:read', 'post:read']);
    const tools = adminMcpTools(appWith(authz), ctxWith(authz)).map((tool) => tool.name);

    expect(tools).toEqual(['admin.post.list', 'admin.post.read', 'admin.search']);
    expect(tools).not.toContain('admin.post.create');
    expect(tools).not.toContain('admin.post.delete');
    expect(tools).not.toContain('admin.action.post.publish');
  });

  test('the action appears exactly when its policy allows it', () => {
    const withAction = staticAuthz(['admin:write', 'post:read', 'post:write', 'post:publish']);
    const tools = adminMcpTools(appWith(withAction), ctxWith(withAction)).map((tool) => tool.name);

    expect(tools).toContain('admin.action.post.publish');
    expect(tools).toContain('admin.post.create');
    expect(tools).toContain('admin.post.update');
    // admin:write implies admin:read, but nothing implies post:delete.
    expect(tools).not.toContain('admin.post.delete');
  });

  test('destructive tools are flagged and demand a confirmation input', () => {
    const authz = staticAuthz(['admin:destroy', 'post:read', 'post:write', 'post:delete']);
    const del = adminMcpTools(appWith(authz), ctxWith(authz)).find(
      (tool) => tool.name === 'admin.post.delete',
    );

    expect(del?.destructive).toBe(true);
    expect(del?.input.map((field) => field.name)).toEqual(['id', 'confirmation']);
  });

  test('an anonymous actor gets no tools at all', () => {
    const authz = staticAuthz([]);
    expect(adminMcpTools(appWith(authz), ctxWith(authz))).toEqual([]);
  });

  test('tool input schemas come from the derived form fields', () => {
    const authz = staticAuthz(['admin:write', 'post:read', 'post:write']);
    const create = adminMcpTools(appWith(authz), ctxWith(authz)).find(
      (tool) => tool.name === 'admin.post.create',
    );

    expect(create?.input.map((field) => field.name)).toEqual(['title']);
    expect(create?.input[0]).toEqual({ name: 'title', type: 'text', required: true });
  });
});
