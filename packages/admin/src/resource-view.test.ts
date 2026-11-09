// A view entity in the admin: listed, read and searched, never created, edited or deleted — no
// route, no button and no MCP tool writes it, even for an actor holding every permission, and an
// override offering a write is refused where it was declared (`X_ADMIN_VIEW_WRITE`).

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, integer, memoryDriver, uuid } from '@ultimat3/entity';
import { defineAdmin } from './admin';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import { adminMcpTools } from './mcp-tools';
import { adminResource } from './resource';

const totals = entity('admin_view_totals', {
  view: { sql: 'select post_id, count(*)::integer as likes from likes group by post_id' },
  columns: { postId: uuid().primaryKey(), likes: integer() },
});

afterAll(clearRegistry);

const actor: AdminActor = { id: 'u_1' };
const everything = staticAuthz([
  'admin:destroy',
  'admin_view_totals:read',
  'admin_view_totals:write',
  'admin_view_totals:delete',
]);

describe('a view entity lists read-only', () => {
  test('its operations are the reads, and its routes are list, lookup and detail', () => {
    expect(adminResource(totals).operations).toEqual(['list', 'detail', 'search']);
    const app = defineAdmin({
      entities: [totals],
      db: database({ totals }, { driver: memoryDriver() }),
      auth: { actor: () => actor, authz: everything },
    });
    expect(
      app.routes.filter((route) => route.entity === 'admin_view_totals').map((r) => r.view),
    ).toEqual(['list', 'lookup', 'detail']);
    const ctx = { actor, authz: everything, audit: memoryAuditLog(), requestId: 'req_1' };
    expect(adminMcpTools(app, ctx).map((tool) => tool.name)).toEqual([
      'admin.admin_view_totals.list',
      'admin.admin_view_totals.read',
      'admin.search',
    ]);
  });

  test('an override offering a write on a view is X_ADMIN_VIEW_WRITE, naming the write', () => {
    expect(() => adminResource(totals, { operations: ['list', 'detail', 'delete'] })).toThrow(
      expect.objectContaining({
        code: 'X_ADMIN_VIEW_WRITE',
        cause: expect.stringContaining('delete'),
      }),
    );
    // Fewer reads is the app's choice, and fine.
    expect(adminResource(totals, { operations: ['list'] }).operations).toEqual(['list']);
  });
});

const archive = entity('admin_ro_archive', {
  readOnly: 'legacy orders, a trigger refuses every insert',
  columns: { id: uuid().primaryKey(), total: integer() },
});

describe('a readOnly entity lists read-only, as a view does', () => {
  test('its operations are the reads; an override offering a write is X_ADMIN_READ_ONLY_WRITE', () => {
    expect(adminResource(archive).operations).toEqual(['list', 'detail', 'search']);
    expect(() => adminResource(archive, { operations: ['list', 'create'] })).toThrow(
      expect.objectContaining({
        code: 'X_ADMIN_READ_ONLY_WRITE',
        cause: expect.stringContaining('legacy orders, a trigger refuses every insert'),
      }),
    );
    expect(adminResource(archive, { operations: ['list'] }).operations).toEqual(['list']);
  });
});
