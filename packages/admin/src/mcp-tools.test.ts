import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import { type AdminApp, defineAdmin } from './admin';
import { memoryAuditLog } from './audit';
import { type AdminActor, type AdminAuthz, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import { adminMcpTools } from './mcp-tools';
import type { AdminAction } from './registry';

const post = entity('admin_tool_post', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

const publish: AdminAction = {
  name: 'post.publish',
  permission: 'admin_tool_post:publish',
  entity: 'admin_tool_post',
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
    const authz = staticAuthz(['admin:read', 'admin_tool_post:read']);
    const tools = adminMcpTools(appWith(authz), ctxWith(authz)).map((tool) => tool.name);

    expect(tools).toEqual([
      'admin.admin_tool_post.list',
      'admin.admin_tool_post.read',
      'admin.search',
    ]);
    expect(tools).not.toContain('admin.admin_tool_post.create');
    expect(tools).not.toContain('admin.admin_tool_post.delete');
    expect(tools).not.toContain('admin.action.post.publish');
  });

  test('the action appears exactly when its policy allows it', () => {
    const withAction = staticAuthz([
      'admin:write',
      'admin_tool_post:read',
      'admin_tool_post:write',
      'admin_tool_post:publish',
    ]);
    const tools = adminMcpTools(appWith(withAction), ctxWith(withAction)).map((tool) => tool.name);

    expect(tools).toContain('admin.action.post.publish');
    expect(tools).toContain('admin.admin_tool_post.create');
    expect(tools).toContain('admin.admin_tool_post.update');
    // admin:write implies admin:read, but nothing implies admin_tool_post:delete.
    expect(tools).not.toContain('admin.admin_tool_post.delete');
  });

  test('destructive tools are flagged and demand a confirmation input', () => {
    const authz = staticAuthz([
      'admin:destroy',
      'admin_tool_post:read',
      'admin_tool_post:write',
      'admin_tool_post:delete',
    ]);
    const del = adminMcpTools(appWith(authz), ctxWith(authz)).find(
      (tool) => tool.name === 'admin.admin_tool_post.delete',
    );

    expect(del?.destructive).toBe(true);
    expect(del?.input.map((field) => field.name)).toEqual(['id', 'confirmation']);
  });

  test('an anonymous actor gets no tools at all', () => {
    const authz = staticAuthz([]);
    expect(adminMcpTools(appWith(authz), ctxWith(authz))).toEqual([]);
  });

  test('tool input schemas come from the derived form fields', () => {
    const authz = staticAuthz(['admin:write', 'admin_tool_post:read', 'admin_tool_post:write']);
    const create = adminMcpTools(appWith(authz), ctxWith(authz)).find(
      (tool) => tool.name === 'admin.admin_tool_post.create',
    );

    expect(create?.input.map((field) => field.name)).toEqual(['title']);
    expect(create?.input[0]).toEqual({ name: 'title', type: 'text', required: true });
  });
});
