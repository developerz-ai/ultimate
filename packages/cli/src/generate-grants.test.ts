// `x g policy` / `x g resource` grant the permissions they declare, in the scaffold's role map —
// against the file `x new` actually writes, so a change to that template that moves the arrays
// this edit looks for fails here and not in an app.

import { describe, expect, test } from 'bun:test';
import { grantsForWritten, insertGrants } from './generate-grants';
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
    expect(source).toContain("grants: ['admin:read', 'customer:write'],");
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
