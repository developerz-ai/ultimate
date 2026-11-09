// The admin is one declaration, so what can go wrong is what it DERIVES: a route table with a
// screen behind every path, each gated — and an authz that asks the role map for every permission,
// so the admin role runs it and nobody else does.
//
// The role map is imported here because nothing else would load it: the boot scan reads
// shared/roles.ts before the first request, and a test that reaches the admin directly has to say
// so — without it the `admin` role grants nothing and every decision below is a refusal.
import { roles } from '@docs-site/web/shared/roles';
import { adminRoutes, permissionsForOperation } from '@ultimat3/admin';
import { expect, unitTest } from '@ultimat3/testing';
import { admin } from './admin';

const ctxFor = (roles: readonly string[]) =>
  admin.ctx({ actor: { id: 'a', roles }, requestId: 'test' });

unitTest('every admin route is gated and has a screen', () => {
  const routes = adminRoutes(admin);
  expect(routes.map((route) => route.path)).toContain('/admin');
  for (const route of routes) {
    // The coarse gate is the first permission of the route's own pair: `admin:read` for a
    // screen that reads, `admin:write` for a form. Never absent.
    expect(route.config.policy?.permission).toBe(route.permissions[0] ?? '');
    expect(route.config.policy?.permission.startsWith('admin:')).toBe(true);
    expect(typeof route.respond).toBe('function');
  }
});

unitTest('one resource per entity on the handle, each reading through it', () => {
  for (const resource of admin.resources) {
    expect(admin.routes.map((route) => route.path)).toContain(`/admin${resource.path}`);
    expect(resource.repo).toBeDefined();
  }
});

unitTest('the admin role holds every permission the admin derives, and a member none', () => {
  // Every route's pair and every operation's — a delete has no route of its own, it is a POST at
  // the row's URL — asked of the role map by name: a table the handle gained without its three
  // grants in shared/roles.ts fails HERE, not as a 403 an operator reports.
  const required = [
    ...new Set([
      ...admin.routes.flatMap((route) => route.permissions),
      ...admin.resources.flatMap((resource) =>
        resource.operations.flatMap((op) => permissionsForOperation(resource.permission, op)),
      ),
    ]),
  ];
  expect(required).toContain('admin:read');
  for (const permission of required) {
    const asked = { permission, subject: { entity: 'any' } };
    const granted = admin.authz.decide({ ...asked, actor: ctxFor(['admin']).actor });
    expect({ permission, allowed: granted.allowed }).toEqual({ permission, allowed: true });
  }
  // Held whether or not the app has a table yet: the first `x g entity` must find them here.
  expect(roles.admin.grants).toContain('admin:write');
  expect(roles.admin.grants).toContain('admin:destroy');
  const refused = admin.authz.decide({
    permission: 'admin:write',
    actor: ctxFor(['member']).actor,
  });
  expect(refused.allowed).toBe(false);
  expect(refused.permission).toBe('admin:write');
});

unitTest('the dashboard answers 200 for the admin role and 403 for anyone else', async () => {
  const [home] = adminRoutes(admin);
  const ask = (roles: readonly string[]) =>
    home?.respond({
      ctx: ctxFor(roles),
      params: {},
      url: 'http://localhost/admin',
      method: 'GET',
      form: null,
    });
  const allowed = await ask(['admin']);
  expect(allowed?.kind === 'document' && allowed.status).toBe(200);
  const denied = await ask(['member']);
  expect(denied?.kind === 'document' && denied.status).toBe(403);
});
