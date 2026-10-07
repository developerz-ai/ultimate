// The `policy` step's grant half, against the real registries: a rule no role can satisfy is the
// 403 a generated resource answered the dev actor with, under a green gate.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnyAction } from '@ultimat3/action';
import { action, listActions, registerAction, resetActions, t } from '@ultimat3/action';
import {
  allow,
  and,
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
  knownPermissions,
  or,
  permissionDeclarationSites,
  restorePermissions,
  restoreRoles,
  roleDeclarationSites,
  roleDefinitions,
} from '@ultimat3/policy';
import { clearRoutes, defineRoute, registerMountedRoutes } from '@ultimat3/render';
import { requirements, ungrantedFinding, ungrantedRequirements } from './permission-grants';

let permissions: readonly string[] = [];
let permissionSites: ReturnType<typeof permissionDeclarationSites> = {};
let roles: ReturnType<typeof roleDefinitions> = {};
let sites: ReturnType<typeof roleDeclarationSites> = {};
// The action registry is process-wide and other files register at module scope: put theirs back.
let actions: readonly AnyAction[] = [];

beforeEach(() => {
  permissions = knownPermissions();
  permissionSites = permissionDeclarationSites();
  roles = roleDefinitions();
  sites = roleDeclarationSites();
  clearPermissions();
  clearRoles();
  clearRoutes();
  actions = listActions();
  resetActions();
});

afterEach(() => {
  resetActions();
  for (const target of actions) registerAction(target.name, target);
  clearRoutes();
  restorePermissions(permissions, permissionSites);
  restoreRoles(roles, sites);
});

const declare = (name: string, policy: Parameters<typeof action>[0]['policy']) =>
  registerAction(
    name,
    action({
      input: t.object({}),
      output: t.object({}),
      policy,
      async handle() {
        return {};
      },
    }),
  );

describe('unit · a permission an action requires must be one some role grants', () => {
  test('a declared, ungranted permission is X_PERMISSION_UNGRANTED naming the action', () => {
    definePermissions(['customer:read', 'customer:write']);
    defineRoles({ member: { description: 'reads', grants: ['customer:read'] } });
    declare('createCustomer', can('customer:write'));
    declare('customerList', can('customer:read'));

    const ungranted = ungrantedRequirements();
    expect(ungranted).toEqual([{ permission: 'customer:write', by: 'action createCustomer' }]);
    const finding = ungrantedFinding(ungranted[0] ?? { permission: '', by: '' }, 'shared/roles.ts');
    expect(finding.code).toBe('X_PERMISSION_UNGRANTED');
    expect(finding.at).toBe('shared/roles.ts');
    expect(finding.fix).toContain(
      `add 'customer:write' to the grants of a role in shared/roles.ts`,
    );
  });

  test('a grant through inheritance or a wildcard counts, because can() counts it', () => {
    definePermissions(['customer:read', 'customer:write']);
    defineRoles({
      member: { description: 'reads', grants: ['customer:read'] },
      admin: { description: 'runs it', grants: ['customer:*'], inherits: ['member'] },
    });
    declare('createCustomer', can('customer:write'));
    expect(ungrantedRequirements()).toEqual([]);
  });

  test('a composite is not judged: one branch of an or() may be deliberately ungranted', () => {
    definePermissions(['a:read', 'b:read']);
    defineRoles({ member: { description: 'reads', grants: ['a:read'] } });
    declare('either', or(can('a:read'), can('b:read')));
    declare('both', and(can('a:read'), can('b:read')));
    declare('open', allow('public'));
    expect(requirements()).toEqual([]);
  });

  test('an app with no role map grants through actors directly and is not judged', () => {
    definePermissions(['customer:write']);
    declare('createCustomer', can('customer:write'));
    expect(requirements()).toEqual([{ permission: 'customer:write', by: 'action createCustomer' }]);
    expect(ungrantedRequirements()).toEqual([]);
  });
});

describe('unit · a permission a MOUNTED route asks must be one some role grants', () => {
  const mountAdmin = (permissions: readonly string[]): void =>
    registerMountedRoutes(
      { key: '/admin', by: 'defineAdmin', file: '@ultimat3/admin', surface: 'app' },
      ['/admin/widgets', '/admin/widgets/:id'].map((path) => ({
        path,
        config: defineRoute({
          render: 'ssr',
          offline: 'network-only',
          hydrate: 'never',
          policy: { permission: 'admin:read' },
          meta: () => ({ title: 'Widgets' }),
        }),
        permissions,
      })),
    );

  test('a hand-written entity with no grants is X_PERMISSION_UNGRANTED, not a 403 an operator reports', () => {
    definePermissions(['admin:read', 'widgets:read']);
    defineRoles({ admin: { description: 'runs it', grants: ['admin:read'] } });
    mountAdmin(['admin:read', 'widgets:read']);

    // EVERY permission of the mount, not only the coarse gate the route's `policy` carries — and
    // one requirement per permission, however many of the mount's routes ask it.
    expect(requirements()).toEqual([
      {
        permission: 'admin:read',
        by: '/admin/widgets (mounted by defineAdmin, and 1 more of its routes)',
      },
      {
        permission: 'widgets:read',
        by: '/admin/widgets (mounted by defineAdmin, and 1 more of its routes)',
      },
    ]);
    const ungranted = ungrantedRequirements();
    expect(ungranted).toEqual([
      {
        permission: 'widgets:read',
        by: '/admin/widgets (mounted by defineAdmin, and 1 more of its routes)',
      },
    ]);
    expect(ungrantedFinding(ungranted[0] ?? { permission: '', by: '' }, 'roles.ts').fix).toContain(
      `add 'widgets:read' to the grants of a role in roles.ts`,
    );
  });

  test('granted through a wildcard, the mount is silent', () => {
    definePermissions(['admin:read', 'widgets:read']);
    defineRoles({ admin: { description: 'runs it', grants: ['admin:read', 'widgets:*'] } });
    mountAdmin(['admin:read', 'widgets:read']);
    expect(ungrantedRequirements()).toEqual([]);
  });
});
