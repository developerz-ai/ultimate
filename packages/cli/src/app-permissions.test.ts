// The `policy` step, driven against the real registries: a grant and a route requirement are both
// bare strings, and this is the only thing between an undeclared one and an HTTP 500.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
  knownPermissions,
  restorePermissions,
  restoreRoles,
  roleDeclarationSites,
  roleDefinitions,
} from '@ultimat3/policy';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { grantedReferences, permissionFindings, policyFindings, siteFile } from './app-permissions';
import type { Finding } from './output';

const ROOT = '/tmp/x-app-permissions';

// `clearPermissions()` is one-way and `definePermissions()` runs at MODULE scope, so a clear here
// is permanent for every later file in the process unless the captured set is put back — the rule
// `packages/policy/src/permissions.ts` spells out on `restorePermissions`.
let permissions: readonly string[] = [];
let roles: ReturnType<typeof roleDefinitions> = {};
let sites: ReturnType<typeof roleDeclarationSites> = {};

beforeEach(() => {
  permissions = knownPermissions();
  roles = roleDefinitions();
  sites = roleDeclarationSites();
  clearPermissions();
  clearRoles();
  clearRoutes();
});

afterEach(() => {
  clearRoutes();
  restorePermissions(permissions);
  restoreRoles(roles, sites);
});

const routeConfig = (permission: string) =>
  defineRoute({
    render: 'ssr',
    hydrate: 'never',
    offline: 'network-only',
    policy: { permission },
    meta: () => ({ title: 'Dashboard', description: 'x'.repeat(60) }),
  });

const codesOf = (findings: readonly Finding[]): readonly string[] =>
  findings.map((finding) => finding.code);

describe('unit · a permission a role grants must be one the app declared', () => {
  test('an undeclared grant is X_PERMISSION_UNKNOWN, which defineRoles never says', () => {
    definePermissions(['admin:read']);
    // Exactly the shipped scaffold's shape: granted, never declared. `defineRoles` returns it.
    defineRoles({ member: { grants: ['dashboard:read'] } });
    const findings = permissionFindings(ROOT);
    expect(codesOf(findings)).toEqual(['X_PERMISSION_UNKNOWN']);
    expect(findings[0]?.cause).toContain('dashboard:read');
  });

  test('a declared grant reports nothing', () => {
    definePermissions(['admin:read', 'dashboard:read']);
    defineRoles({ member: { grants: ['dashboard:read'] }, admin: { grants: ['admin:read'] } });
    expect(permissionFindings(ROOT)).toEqual([]);
  });

  test('an app that declared no permissions at all is not judged — can() does not judge it either', () => {
    defineRoles({ member: { grants: ['dashboard:read'] } });
    expect(permissionFindings(ROOT)).toEqual([]);
  });
});

describe('unit · a permission a route requires must be one the app declared', () => {
  test('the route table is read, not the source — the same field dev-hooks builds can() from', () => {
    definePermissions(['admin:read']);
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: routeConfig('dashboard:read'),
    });
    const findings = permissionFindings(ROOT);
    expect(codesOf(findings)).toEqual(['X_PERMISSION_UNKNOWN']);
    expect(findings[0]?.at).toBe('apps/web/app/dashboard/page.tsx');
  });

  test('a declared requirement reports nothing', () => {
    definePermissions(['dashboard:read']);
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: routeConfig('dashboard:read'),
    });
    expect(permissionFindings(ROOT)).toEqual([]);
  });
});

describe('unit · the step reports one finding per place, and carries the load', () => {
  test('granted AND required is two findings, because it is two edits', async () => {
    definePermissions(['admin:read']);
    defineRoles({ member: { grants: ['dashboard:read'] } });
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: routeConfig('dashboard:read'),
    });
    const findings = await policyFindings(ROOT, async () => ({ findings: [] }));
    expect(findings).toHaveLength(2);
  });

  test("the loader's own findings ride along only when something is unknown", async () => {
    const loadFailure: Finding = {
      code: 'X_CLI_UNEXPECTED',
      cause: 'boom',
      fix: 'x doctor --json',
    };
    definePermissions(['admin:read']);
    expect(await policyFindings(ROOT, async () => ({ findings: [loadFailure] }))).toEqual([]);
    defineRoles({ member: { grants: ['dashboard:read'] } });
    expect(codesOf(await policyFindings(ROOT, async () => ({ findings: [loadFailure] })))).toEqual([
      'X_PERMISSION_UNKNOWN',
      'X_CLI_UNEXPECTED',
    ]);
  });

  test('a role declared inside the app root is located; one outside it is not guessed at', () => {
    definePermissions(['admin:read']);
    defineRoles({ member: { grants: ['dashboard:read'] } });
    // The site is this test file, which is not under ROOT — so no locator is invented.
    expect(grantedReferences(ROOT)[0]?.at).toBeUndefined();
  });
});

describe('unit · a stack frame reduced to a file an agent can open', () => {
  test('an absolute path under the root becomes a relative one', () => {
    expect(siteFile('/app', 'at defineRoles (/app/apps/web/shared/roles.ts:22:14)')).toBe(
      'apps/web/shared/roles.ts',
    );
  });

  test('a path outside the root and an unreadable frame both answer undefined', () => {
    expect(siteFile('/app', 'at x (/elsewhere/roles.ts:1:1)')).toBeUndefined();
    expect(siteFile('/app', 'unknown site')).toBeUndefined();
  });
});
