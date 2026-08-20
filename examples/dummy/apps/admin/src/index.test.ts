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
 * Two `@ultimat3/admin` defects, asserted AS THEY ARE so the gate stays honest rather than
 * flattering. Both are the framework's to fix; when either is, this test goes red and whoever
 * fixed it updates the line deliberately — which is the point of pinning them here.
 *
 *  1. **Double pluralisation.** Every entity name here is already plural, and the route builder
 *     pluralises again: `orgs` -> `orgses`, `members` -> `memberses`. Every admin URL this app
 *     would serve is misspelled.
 *  2. **The nav omits `basePath`.** `nav` links to `/orgses` while the route is `/admin/orgses`,
 *     so every navigation link in the dashboard points at a path no route matches. This is the
 *     one that makes the dashboard unusable rather than merely ugly, and it is invisible to any
 *     test that checks the nav or the routes alone — it only shows when the two are compared.
 */
describe('known @ultimat3/admin defects, pinned so they cannot be forgotten', () => {
  test('entity names are pluralised twice in every route path', () => {
    const paths = admin.routes.map((route) => route.path);
    expect(paths).toContain('/admin/orgses');
    expect(paths).toContain('/admin/memberses');
    expect(paths).not.toContain('/admin/orgs');
  });

  test('no nav href matches any route path, because nav drops the base path', () => {
    const paths = new Set(admin.routes.map((route) => route.path));
    const hrefs = admin.nav.flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => paths.has(href))).toEqual([]);
    expect(hrefs).toContain('/orgses');
    expect(admin.basePath).toBe('/admin');
  });
});
