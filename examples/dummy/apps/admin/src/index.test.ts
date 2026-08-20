/**
 * unit — the dashboard is CONSTRUCTED, and what it projects is asserted.
 *
 * This file exists because `apps/admin/src/index.ts` had no test and no importer: nothing in this
 * repo ever evaluated it, so `defineAdmin`/`adminMcp` had never run against this app's real
 * entities and actions. `README.md` advertises it as "the whole dashboard, 20 lines of
 * `defineAdmin`" — a claim nothing checked. Two `@ultimat3/admin` defects were invisible for
 * exactly that reason and are named at the bottom of this file.
 *
 * Nothing here mounts anything: `adminAgents.route` is a route descriptor no server serves, the
 * same gap `app/auth/login.ts` carries and for the same reason — an app has no seam by which to
 * contribute a raw `Route`.
 */

import { describe, expect, test } from 'bun:test';
import { admin, adminAgents } from './index';

describe('the dashboard is derived from the entities, not restated', () => {
  test('the four entities become resources, in declaration order', () => {
    expect(admin.resources.map((resource) => resource.name)).toEqual([
      'orgs',
      'members',
      'posts',
      'comments',
    ]);
  });

  /**
   * The real assertion is that this does not THROW. `toolbarAction` reads the permission off the
   * action's own policy object and raises `X_ADMIN_POLICY_MISSING` when the policy carries none or
   * carries more than one — so projecting these three at module scope is what proves each of
   * `publishPost`, `inviteMember` and `upgradePlan` still declares exactly one permission. A
   * composite policy on any of them turns this file red at import.
   */
  test('each toolbar action lands on its own entity, one action apiece', () => {
    const projected = admin.resources.map(
      (resource) => `${resource.name}:${(resource.actions ?? []).map((a) => a.name).join(',')}`,
    );
    expect(projected).toEqual([
      'orgs:upgradePlan',
      'members:inviteMember',
      'posts:publishPost',
      'comments:',
    ]);
  });
});

describe('the agent surface is the same dashboard, projected again', () => {
  test('every resource gets the five CRUD tools, and each action gets one more', () => {
    const tools = adminAgents.tools.map((tool) => tool.name);
    for (const entity of ['orgs', 'members', 'posts', 'comments']) {
      for (const op of ['list', 'read', 'create', 'update', 'delete']) {
        expect(tools).toContain(`admin.${entity}.${op}`);
      }
    }
    expect(tools).toContain('admin.action.publishPost');
    expect(tools).toContain('admin.action.inviteMember');
    expect(tools).toContain('admin.action.upgradePlan');
    expect(tools).toContain('admin.search');
    // 4 entities x 5 operations + 3 actions + search. A tool that appears without a declaration
    // behind it is the thing this count catches.
    expect(tools).toHaveLength(24);
  });

  test('the MCP route is built and served by nothing — declared, unmounted', () => {
    // Not a complaint about this file: an app contributes actions, queries and pages to
    // `packages/cli/src/serve.ts`, and there is no seam for a raw `Route`. Same standing gap as
    // `app/auth/login.ts`'s two descriptors. Pinned so "unmounted" stays a fact somebody chose.
    // `route` is optional on the projection, so it is narrowed rather than asserted through:
    // "there is no route" and "the route is unmounted" are different facts and only one is true.
    const route = adminAgents.route;
    expect(route).toBeDefined();
    expect(route?.method).toBe('POST');
    expect(typeof route?.handle).toBe('function');
  });
});

/**
 * The double-pluralisation bug this block used to pin is **fixed**: `adminResource` no longer
 * guesses English morphology, so an entity named `orgs` is served at `/admin/orgs`. Which plural
 * a name takes is an app's convention, not a mechanism the framework can own (axiom 8), and
 * `path:` was always the override.
 *
 * The nav "bug" it also pinned **was never one**, and this is the more useful lesson. The old
 * assertion compared `nav` hrefs against route paths and found them disjoint — but hrefs are
 * base-relative by design and `layout.tsx:82` composes `${basePath}${item.href}`, which
 * `layout.test.ts` has always asserted. Comparing an uncomposed href to a composed path is
 * disjoint by construction, so the test passed while proving nothing. It is replaced below by the
 * invariant that does matter: every nav href must resolve to a real route AFTER composition.
 */
describe('routes are the entity names, not a guess about English', () => {
  test('an already-plural entity name is served once, not twice', () => {
    const paths = admin.routes.map((route) => route.path);
    expect(paths).toContain('/admin/orgs');
    expect(paths).toContain('/admin/members');
    expect(paths).not.toContain('/admin/orgses');
  });

  test('nav hrefs are base-relative, and the layout is what makes them absolute', () => {
    const hrefs = admin.nav.flatMap((group) => group.items.map((item) => item.href));
    const paths = admin.routes.map((route) => route.path);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs).toContain('/orgs');
    expect(admin.basePath).toBe('/admin');
    for (const href of hrefs) {
      expect(paths).toContain(`${admin.basePath}${href}`);
    }
  });
});
