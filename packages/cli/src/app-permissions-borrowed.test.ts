// The `policy` step's provenance question, against the real registries: an app rule that holds
// only because `@ultimat3/admin`'s `defineAdmin()` declared its permission is flagged, and one the
// app declares itself — wherever else it is also declared — is not.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnyAction } from '@ultimat3/action';
import { action, listActions, registerAction, resetRegistry, t } from '@ultimat3/action';
import {
  can,
  clearPermissions,
  definePermissions,
  knownPermissions,
  or,
  permissionDeclarationSites,
  restorePermissions,
} from '@ultimat3/policy';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import {
  appRules,
  borrowedFinding,
  borrowedPermissions,
  permissionsFile,
} from './app-permissions-borrowed';

const ROOT = '/srv/app';
const ADMIN_SITE =
  'at declareAdminPermissions (/srv/app/node_modules/@ultimat3/admin/src/policy-bridge.ts:73:3)';
const MONOREPO_ADMIN_SITE =
  'at declareAdminPermissions (/repo/packages/admin/src/policy-bridge.ts:73:3)';
const APP_SITE = 'at /srv/app/apps/web/shared/permissions.ts:4:1';

let permissions: readonly string[] = [];
let sites: ReturnType<typeof permissionDeclarationSites> = {};
let actions: readonly AnyAction[] = [];

beforeEach(() => {
  permissions = knownPermissions();
  sites = permissionDeclarationSites();
  clearPermissions();
  clearRoutes();
  actions = listActions();
  resetRegistry();
});

afterEach(() => {
  resetRegistry();
  for (const target of actions) registerAction(target.name, target);
  clearRoutes();
  restorePermissions(permissions, sites);
});

/** The registry as a process holds it: each name with the frames that declared it. */
const declaredAs = (at: Readonly<Record<string, readonly string[]>>): void =>
  restorePermissions(Object.keys(at), at);

const rule = (permission: string, by = 'action createPost') => ({ permission, by });

describe('unit · which app rules lean on a permission only a package declared', () => {
  test('declared only by defineAdmin, from an installed copy, is borrowed', () => {
    declaredAs({ 'posts:read': [ADMIN_SITE] });
    expect(borrowedPermissions(ROOT, [rule('posts:read')])).toEqual([
      { ...rule('posts:read'), from: ['node_modules/@ultimat3/admin/src/policy-bridge.ts'] },
    ]);
  });

  // On Windows every frame is `C:\\…` and none begins with `/`: `frameFile` read none of them,
  // so every name had an "unreadable" site and X_PERMISSION_BORROWED could never fire.
  test('Windows-shaped frames are read: borrowed from a package, located in the app', () => {
    const root = 'C:\\srv\\app';
    const adminSite =
      'at declareAdminPermissions (C:\\srv\\app\\node_modules\\@ultimat3\\admin\\src\\policy-bridge.ts:73:3)';
    const appSite = 'at C:\\srv\\app\\apps\\web\\shared\\permissions.ts:4:1';
    declaredAs({ 'posts:read': [adminSite], 'posts:write': [adminSite, appSite] });
    expect(borrowedPermissions(root, [rule('posts:read'), rule('posts:write')])).toEqual([
      { ...rule('posts:read'), from: ['node_modules/@ultimat3/admin/src/policy-bridge.ts'] },
    ]);
    expect(permissionsFile(root)).toBe('apps/web/shared/permissions.ts');
  });

  // Every external declarer is named: reporting the first alone said one package declared it.
  test('declared by two packages, both are named, once each', () => {
    declaredAs({
      'posts:read': [ADMIN_SITE, MONOREPO_ADMIN_SITE, ADMIN_SITE.replace(':73:3', ':80:1')],
    });
    expect(borrowedPermissions(ROOT, [rule('posts:read')])[0]?.from).toEqual([
      '../../repo/packages/admin/src/policy-bridge.ts',
      'node_modules/@ultimat3/admin/src/policy-bridge.ts',
    ]);
  });

  test('declared only by defineAdmin, from a workspace copy outside the app, is borrowed', () => {
    declaredAs({ 'posts:read': [MONOREPO_ADMIN_SITE] });
    expect(borrowedPermissions(ROOT, [rule('posts:read')])).toEqual([
      { ...rule('posts:read'), from: ['../../repo/packages/admin/src/policy-bridge.ts'] },
    ]);
  });

  test('declared by the app as well is not borrowed, whatever else declared it', () => {
    declaredAs({ 'posts:read': [ADMIN_SITE, APP_SITE] });
    expect(borrowedPermissions(ROOT, [rule('posts:read')])).toEqual([]);
  });

  // A site no frame can be read from is provenance nobody can state: not provably borrowed.
  test('a permission with any unreadable site, or none recorded, is not judged', () => {
    declaredAs({
      'posts:read': ['unknown site'],
      'posts:write': [],
      'posts:delete': [ADMIN_SITE, 'unknown site'],
    });
    const rules = [rule('posts:read'), rule('posts:write'), rule('posts:delete')];
    expect(borrowedPermissions(ROOT, rules)).toEqual([]);
  });

  // An unknown name is X_PERMISSION_UNKNOWN's, asked first by the step; a second finding for it
  // here would be two instructions for one fault.
  test('an undeclared permission is left to X_PERMISSION_UNKNOWN', () => {
    declaredAs({ 'posts:read': [APP_SITE] });
    expect(borrowedPermissions(ROOT, [rule('posts:publish')])).toEqual([]);
  });

  test('one finding per permission per rule, sorted', () => {
    declaredAs({ 'posts:read': [ADMIN_SITE], 'posts:write': [ADMIN_SITE] });
    const found = borrowedPermissions(ROOT, [
      rule('posts:write', 'query b'),
      rule('posts:read', 'query b'),
      rule('posts:read', 'action a'),
      rule('posts:read', 'action a'),
    ]);
    expect(found.map((entry) => `${entry.permission} ${entry.by}`)).toEqual([
      'posts:read action a',
      'posts:read query b',
      'posts:write query b',
    ]);
  });
});

describe('unit · the rules the app itself declares', () => {
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

  // Every permission in the tree, composites included: an `or()` branch is still a `can()` that
  // asserts its name at declaration, so it needs the app's own declaration as much as a bare one.
  test('actions name every permission their tree requires; routes their guard', () => {
    definePermissions(['posts:read', 'posts:write', 'dash:read']);
    declare('createPost', or(can('posts:write'), can('posts:read')));
    registerRoute({
      file: 'apps/web/app/dash/page.tsx',
      config: defineRoute({
        render: 'ssr',
        hydrate: 'never',
        offline: 'network-only',
        policy: { permission: 'dash:read' },
        meta: () => ({ title: 'Dash', description: 'x'.repeat(60) }),
      }),
    });
    expect(appRules()).toEqual([
      { permission: 'posts:read', by: 'action createPost' },
      { permission: 'posts:write', by: 'action createPost' },
      { permission: 'dash:read', by: 'apps/web/app/dash/page.tsx' },
    ]);
  });
});

describe('unit · the finding', () => {
  test('names the rule, the package that declared it, and the app file to declare it in', () => {
    const finding = borrowedFinding(
      { ...rule('posts:read'), from: ['node_modules/@ultimat3/admin/src/policy-bridge.ts'] },
      'apps/web/shared/permissions.ts',
    );
    expect(finding.code).toBe('X_PERMISSION_BORROWED');
    expect(finding.at).toBe('apps/web/shared/permissions.ts');
    expect(finding.cause).toBe(
      "action createPost requires 'posts:read', and only node_modules/@ultimat3/admin/src/policy-bridge.ts declares it — no app module does, so the rule holds only in a process that ran that package's declaration (defineAdmin()) first; paste this call into apps/web/shared/permissions.ts (definePermissions() merges, so a second call is fine), then x verify --only policy",
    );
    // A call to paste — never prose a shell would read as a command named `add`.
    expect(finding.fix).toBe("definePermissions(['posts:read'])");
  });

  test('two declarers are both named in the cause', () => {
    const finding = borrowedFinding({ ...rule('posts:read'), from: ['a.ts', 'b.ts'] }, undefined);
    expect(finding.cause).toContain('and only a.ts, b.ts declare it — no app module does');
  });

  test('with no app declaration to extend, the cause says where the call goes', () => {
    const finding = borrowedFinding({ ...rule('posts:read'), from: ['x.ts'] }, undefined);
    expect(finding.at).toBeUndefined();
    expect(finding.fix).toBe("definePermissions(['posts:read'])");
    expect(finding.cause).toContain('paste this call into an app module');
  });

  // The name is app data spliced into code: one carrying a quote is rendered as a JSON literal.
  test('a name that would break a single-quoted literal is escaped', () => {
    const finding = borrowedFinding({ ...rule("posts:it's"), from: ['x.ts'] }, undefined);
    expect(finding.fix).toBe('definePermissions(["posts:it\'s"])');
  });

  test('the app file is read off the app-side declaration sites, never guessed', () => {
    declaredAs({ 'posts:read': [ADMIN_SITE], 'org:read': [APP_SITE] });
    expect(permissionsFile(ROOT)).toBe('apps/web/shared/permissions.ts');
    declaredAs({ 'posts:read': [ADMIN_SITE] });
    expect(permissionsFile(ROOT)).toBeUndefined();
  });
});
