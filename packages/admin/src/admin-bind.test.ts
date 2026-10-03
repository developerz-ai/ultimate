// What `defineAdmin` binds when it is told nothing but the entities and the handle: a repo per
// resource from the app's own tables, the request's own actor, and the role map as the authz.
// And the one thing it refuses: a resource with nothing to read rows through.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import {
  can,
  defineRoles,
  isKnownPermission,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import { defineAdmin } from './admin';
import { staticAuthz } from './authz';
import { adminList } from './crud';
import { roleAuthz, singlePolicyAuthz } from './policy-bridge';
import type { AdminRepo, AdminRow } from './registry';

const posts = entity('admin_bind_posts', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }) },
});
const notes = entity('admin_bind_notes', {
  columns: { id: uuid().primaryKey(), body: text({ max: 80 }) },
});

const db = database({ posts }, { driver: memoryDriver() });

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

beforeAll(async () => {
  await db.posts.insert({ title: 'Bound' });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

const stub: AdminRepo<AdminRow> = {
  list: async () => [{ id: 'n_1', body: 'from the override' }],
  find: async () => null,
  create: async (input) => input,
  update: async (_id, patch) => patch,
  destroy: async () => undefined,
};

const thrown = (run: () => unknown): { code?: string; cause?: string; fix?: string } => {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('expected defineAdmin to refuse');
};

describe('unit · defineAdmin binds each resource to the handle', () => {
  test('an entity in the handle reads through its own table — no adapter was written', async () => {
    const app = defineAdmin({
      entities: [posts],
      db,
      auth: { authz: staticAuthz(['admin:read', 'admin_bind_posts:read']) },
    });
    const listed = await adminList(
      app.resource('admin_bind_posts'),
      app.ctx({ actor: { id: 'u' }, requestId: 'r' }),
    );
    expect(listed.ok && listed.page.rows.map((row) => row['title'])).toEqual(['Bound']);
  });

  test('`resources.<entity>.repo` replaces the table for that ONE resource', async () => {
    const app = defineAdmin({
      entities: [posts, notes],
      db,
      resources: { admin_bind_notes: { repo: stub } },
      auth: { authz: staticAuthz(['admin:read', 'admin_bind_notes:read']) },
    });
    const listed = await adminList(
      app.resource('admin_bind_notes'),
      app.ctx({ actor: { id: 'u' }, requestId: 'r' }),
    );
    expect(listed.ok && listed.page.rows.map((row) => row['body'])).toEqual(['from the override']);
    // The other resource is untouched by it: still the handle's table.
    expect(app.resource('admin_bind_posts').repo).not.toBe(stub);
  });

  test('no handle and no repo is X_ADMIN_REPO_UNBOUND at DECLARATION, naming the edit', () => {
    const seen = thrown(() => defineAdmin({ entities: [posts] }));
    expect(seen.code).toBe('X_ADMIN_REPO_UNBOUND');
    expect(seen.cause).toContain('admin_bind_posts');
    expect(seen.fix).toContain('defineAdmin({ entities, db })');
  });

  test('a handle that does not carry the entity is the same refusal, listing what it does carry', () => {
    const seen = thrown(() => defineAdmin({ entities: [notes], db }));
    expect(seen.code).toBe('X_ADMIN_REPO_UNBOUND');
    expect(seen.cause).toContain('admin_bind_notes');
    expect(seen.cause).toContain('admin_bind_posts');
  });

  test('an admin of pages only needs neither', () => {
    expect(() => defineAdmin({ entities: [] })).not.toThrow();
  });
});

describe('unit · defineAdmin’s auth defaults', () => {
  test('the actor is the request’s own; with no request in flight it is anonymous', async () => {
    const app = defineAdmin({ entities: [posts], db });
    expect((await app.requestCtx(new Request('http://localhost/admin'))).actor.id).toBe(
      'anonymous',
    );

    const context = createContext({
      actor: userActor({ id: 'u_3', roles: ['viewer'], orgId: 'o' }),
    });
    const ctx = await runWithContext(context, () =>
      app.requestCtx(new Request('http://localhost/admin')),
    );
    expect(ctx.actor.id).toBe('u_3');
    expect(ctx.actor.orgId).toBe('o');
    expect(ctx.requestId).toBe(context.requestId);
  });

  test('a supplied `actor` hook wins, and is handed the request', async () => {
    const seen: string[] = [];
    const app = defineAdmin({
      entities: [posts],
      db,
      auth: {
        actor: (request) => {
          seen.push(new URL(request.url).pathname);
          return { id: 'from-the-hook' };
        },
      },
    });
    expect((await app.requestCtx(new Request('http://localhost/admin/x'))).actor.id).toBe(
      'from-the-hook',
    );
    expect(seen).toEqual(['/admin/x']);
  });

  test('the authz is the ROLE MAP: a role that grants the pair lists, one that does not is refused', async () => {
    const app = defineAdmin({ entities: [posts], db });
    defineRoles({
      ...previousRoles,
      bind_reader: { grants: ['admin:read', 'admin_bind_posts:read'] },
      bind_stranger: { grants: [] },
    });
    const as = (role: string) => app.ctx({ actor: { id: 'u', roles: [role] }, requestId: 'r' });

    expect((await adminList(app.resource('admin_bind_posts'), as('bind_reader'))).ok).toBe(true);
    const refused = await adminList(app.resource('admin_bind_posts'), as('bind_stranger'));
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.decision.permission).toBe('admin:read');
  });

  test('every permission the admin derives is declared, so a role can grant it and `can()` can hear it', () => {
    defineAdmin({ entities: [posts], db });
    for (const permission of [
      'admin_bind_posts:read',
      'admin_bind_posts:write',
      'admin_bind_posts:delete',
      'job:read',
      'audit:read',
    ]) {
      expect({ permission, known: isKnownPermission(permission) }).toEqual({
        permission,
        known: true,
      });
    }
  });
});

describe('unit · roleAuthz', () => {
  test('a name that is not resource:verb, or that nothing declared, is DENIED — never thrown', () => {
    const authz = roleAuthz();
    const actor = { id: 'u', roles: ['bind_reader'] };
    for (const permission of ['not-a-permission', 'admin_bind_nowhere:read']) {
      const decision = authz.decide({ permission, actor });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('admin.policy.missing');
      expect(decision.trace.join(' ')).toContain('definePermissions');
    }
  });

  test('applies the admin implications staticAuthz applies: destroy ⇒ write ⇒ read, and no further', () => {
    defineRoles({ ...previousRoles, bind_destroyer: { grants: ['admin:destroy'] } });
    const authz = roleAuthz();
    const actor = { id: 'u', roles: ['bind_destroyer'] };
    const verdict = (permission: string) => authz.decide({ permission, actor }).allowed;
    expect(verdict('admin:destroy')).toBe(true);
    expect(verdict('admin:write')).toBe(true);
    expect(verdict('admin:read')).toBe(true);
    // An implication runs DOWN only, and only the admin's own table.
    expect(verdict('admin:impersonate')).toBe(false);
    const written = authz.decide({ permission: 'admin:write', actor });
    expect(written.trace.join(' ')).toContain('admin:destroy');
    // The same grant list through `staticAuthz` answers every one of them the same way.
    const stat = staticAuthz(['admin:destroy']);
    for (const permission of ['admin:destroy', 'admin:write', 'admin:read', 'admin:impersonate']) {
      expect(verdict(permission)).toBe(stat.decide({ permission, actor }).allowed);
    }
  });
});

describe('unit · singlePolicyAuthz', () => {
  test('one policy answers every gate, and the decision still names the permission that was asked', () => {
    defineRoles({ ...previousRoles, bind_runner: { grants: ['admin:read'] } });
    const authz = singlePolicyAuthz(can('admin:read'));
    const runner = { id: 'u', roles: ['bind_runner'] };

    for (const permission of ['admin:write', 'admin_bind_posts:delete', 'job:read']) {
      const decision = authz.decide({ permission, actor: runner });
      expect({ permission, allowed: decision.allowed, named: decision.permission }).toEqual({
        permission,
        allowed: true,
        named: permission,
      });
    }
    // The same question from an actor who does not hold the one grant: refused, every time.
    const stranger = authz.decide({ permission: 'admin:read', actor: { id: 'u', roles: [] } });
    expect(stranger.allowed).toBe(false);
    expect(stranger.reason).toContain('admin:read');
  });
});
