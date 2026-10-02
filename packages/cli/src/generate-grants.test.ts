// `x g policy` / `x g resource` grant the permissions they declare, in the scaffold's role map —
// against the file `x new` actually writes, so a change to that template that moves the arrays
// this edit looks for fails here and not in an app.

import { describe, expect, test } from 'bun:test';
import {
  adminGrantsFor,
  grantsForWritten,
  insertGrants,
  insertPermissions,
} from './generate-grants';
import { rolesFiles } from './templates/scaffold-roles';

const scaffolded = String(rolesFiles()[0]?.contents ?? '');

describe('unit · the grants a generated policy implies', () => {
  test('a written policy.ts grants read to member and write to admin', () => {
    expect(
      grantsForWritten([
        'apps/web/app/customer/policy.ts',
        'apps/web/app/customer/policy.test.ts',
        'apps/web/app/customer/entity.ts',
      ]),
    ).toEqual([
      { role: 'member', permission: 'customer:read' },
      { role: 'admin', permission: 'customer:write' },
    ]);
  });

  test('nothing else implies a grant', () => {
    expect(grantsForWritten(['apps/web/app/customer/actions/create-customer.ts'])).toEqual([]);
  });
});

describe('unit · inserting a grant into the scaffolded role map', () => {
  test('each permission lands in its role and nowhere else', () => {
    const { source, skipped } = insertGrants(
      scaffolded,
      grantsForWritten(['apps/web/app/customer/policy.ts']),
    );
    expect(skipped).toEqual([]);
    expect(source).toContain("grants: ['dashboard:read', 'customer:read'],");
    expect(source).toContain(
      "      'admin:destroy',\n      'job:read',\n      'audit:read',\n      'customer:write',\n    ],",
    );
  });

  test('a second run changes nothing', () => {
    const grants = grantsForWritten(['apps/web/app/customer/policy.ts']);
    const once = insertGrants(scaffolded, grants).source;
    expect(insertGrants(once, grants).source).toBe(once);
  });

  test('a list past the line width is wrapped the way Biome prints it', () => {
    let source = scaffolded;
    for (const feature of ['subscription-invoice-line', 'credit-note-attachment', 'audit-log']) {
      source = insertGrants(source, [{ role: 'member', permission: `${feature}:read` }]).source;
    }
    expect(source).toContain(
      "    grants: [\n      'dashboard:read',\n      'subscription-invoice-line:read',\n",
    );
    expect(source).toContain("      'audit-log:read',\n    ],\n");
  });

  test('a role the map does not declare is skipped, never guessed at', () => {
    const grant = { role: 'owner', permission: 'customer:write' };
    const { source, skipped } = insertGrants(scaffolded, [grant]);
    expect(source).toBe(scaffolded);
    expect(skipped).toEqual([grant]);
  });
});

// The admin asks `<table>:read|write|delete` for every entity on the handle, and a written entity
// IS on the handle: without these three grants the screen `x g entity` just created refuses the
// very role that runs the admin.
describe('unit · the grants a generated entity implies, for the admin that serves it', () => {
  test('the admin role is granted the table’s three permissions — named for the TABLE', () => {
    expect(adminGrantsFor('widgets')).toEqual([
      { role: 'admin', permission: 'widgets:read' },
      { role: 'admin', permission: 'widgets:write' },
      { role: 'admin', permission: 'widgets:delete' },
    ]);
  });

  test('each is DECLARED in the role map’s own definePermissions() before it is granted', () => {
    const permissions = adminGrantsFor('widgets').map((grant) => grant.permission);
    const declared = insertPermissions(scaffolded, permissions);
    expect(declared.skipped).toEqual([]);
    expect(declared.source).toContain("  'dashboard:read',\n  'widgets:read',");
    expect(declared.source).toContain("  'widgets:delete',\n]);");
    const { source, skipped } = insertGrants(declared.source, adminGrantsFor('widgets'));
    expect(skipped).toEqual([]);
    expect(source).toContain(
      "      'widgets:read',\n      'widgets:write',\n      'widgets:delete',",
    );
    // A member is granted none of them: the admin's tables are the admin role's.
    expect(source).toContain("grants: ['dashboard:read'],");
  });

  test('a second run declares and grants nothing twice', () => {
    const permissions = adminGrantsFor('widgets').map((grant) => grant.permission);
    const once = insertGrants(
      insertPermissions(scaffolded, permissions).source,
      adminGrantsFor('widgets'),
    ).source;
    expect(insertPermissions(once, permissions).source).toBe(once);
    expect(insertGrants(once, adminGrantsFor('widgets')).source).toBe(once);
  });

  test('a role map with no definePermissions([…]) to add to is reported, never guessed at', () => {
    const bare = 'export const roles = defineRoles({ admin: { grants: [] } });\n';
    expect(insertPermissions(bare, ['widgets:read'])).toEqual({
      source: bare,
      skipped: ['widgets:read'],
    });
  });
});

describe('unit · the scaffolded admin role holds what the admin derives', () => {
  test('all three admin gates — a role holding `admin:read` alone reads and cannot write', () => {
    for (const permission of ['admin:read', 'admin:write', 'admin:destroy']) {
      expect(scaffolded).toContain(`'${permission}'`);
    }
    expect(scaffolded).toContain(
      "definePermissions([\n  'admin:read',\n  'admin:write',\n  'admin:destroy',\n  'job:read',\n  'audit:read',\n  'dashboard:read',\n]);",
    );
    // The two built-in screens with no table behind them are the admin role's too.
    expect(scaffolded).toContain(
      "grants: ['admin:read', 'admin:write', 'admin:destroy', 'job:read', 'audit:read'],",
    );
  });

  test('with the example slice, the table it adds to the handle is granted too', () => {
    const example = String(rolesFiles(true)[0]?.contents ?? '');
    for (const permission of ['posts:read', 'posts:write', 'posts:delete']) {
      // Declared once and granted once.
      expect(example.split(`'${permission}'`)).toHaveLength(3);
    }
    expect(scaffolded).not.toContain('posts:');
  });
});
