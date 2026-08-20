// The sidebar. Two rules, and both are authz rules wearing navigation clothes: a link an actor
// cannot open is not a link, and a custom page's own permissions decide its item — without them
// an ops screen was listed to everybody, because a page has no entity to gate on.

import { describe, expect, test } from 'bun:test';
import { memoryAuditLog } from './audit';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminAuthzQuery,
  type AdminDecision,
  allowed,
  denied,
} from './authz';
import type { CrudCtx } from './crud';
import { adminNav, type NavItem, visibleNav } from './nav';
import type { AdminColumnMeta, AdminEntity } from './registry';
import { type AdminResource, adminResource } from './resource';

const meta = (over: Partial<AdminColumnMeta> = {}): { $meta: AdminColumnMeta } => ({
  $meta: { kind: 'text', notNull: true, primaryKey: false, unique: false, index: false, ...over },
});

const shaped = (name: string): AdminEntity => ({
  $name: name,
  $primaryKey: ['id'],
  $columns: { id: meta({ kind: 'uuid', primaryKey: true }), title: meta() },
  $schema: undefined,
  $describe: () => ({ columns: [] }),
});

const resourceNamed = (name: string, group?: string): AdminResource =>
  adminResource(shaped(name), group === undefined ? {} : { group });

// Declaration order is deliberately NOT alphabetical: it is the order the domain reads in.
const POST = resourceNamed('post');
const TAG = resourceNamed('tag');
const INVOICE = resourceNamed('invoice', 'admin.group.billing');
const RESOURCES = [POST, TAG, INVOICE];

const ACTOR: AdminActor = { id: 'u_1', roles: ['viewer'], orgId: 'org_1' };

function ctxFor(grant: ReadonlySet<string>): CrudCtx & { readonly asked: AdminAuthzQuery[] } {
  const asked: AdminAuthzQuery[] = [];
  const authz: AdminAuthz = {
    decide(query): AdminDecision {
      asked.push(query);
      return grant.has(query.permission)
        ? allowed(query.permission, 'probe.granted')
        : denied(query.permission, 'probe.refused');
    },
  };
  return { actor: ACTOR, authz, audit: memoryAuditLog(), requestId: 'req_nav', asked };
}

describe('adminNav groups the resources', () => {
  test('with no options, each resource lands in its own declared group, in declaration order', () => {
    const nav = adminNav(RESOURCES);
    expect(nav.map((group) => group.key)).toEqual(['admin.group.data', 'admin.group.billing']);
    expect(nav[0]?.items.map((item) => item.key)).toEqual(['post', 'tag']);
    expect(nav[1]?.items.map((item) => item.key)).toEqual(['invoice']);
  });

  test('an item carries the resource’s own title key and path, never a guessed URL', () => {
    const item = adminNav([POST])[0]?.items[0];
    expect(item).toEqual({
      key: 'post',
      labelKey: 'admin.post.title',
      href: '/post',
      entity: 'post',
    });
  });

  /**
   * The half the test above is named for and did not check: `href` is the resource's OWN path,
   * copied, not a URL this file assembles. It read `/posts` for an entity named `post` until
   * `adminResource` stopped pluralising — a guessed URL asserted by a test that says it forbids
   * them. Reading it off the resource is what makes the two impossible to drift.
   */
  test('href is the resource path verbatim, whatever the resource says it is', () => {
    const custom = adminResource(shaped('post'), { path: '/editorial/pieces' });
    expect(adminNav([custom])[0]?.items[0]?.href).toBe('/editorial/pieces');
  });

  test('an explicit groups map decides both order and membership', () => {
    const nav = adminNav(RESOURCES, {
      groups: { 'admin.group.content': ['tag', 'post'] },
    });
    expect(nav.map((group) => group.key)).toEqual([
      'admin.group.content',
      // Not named in `groups`, so it falls through to its own declared group, appended after.
      'admin.group.billing',
    ]);
    // The order inside the group is the MAP's, not the registry's.
    expect(nav[0]?.items.map((item) => item.key)).toEqual(['tag', 'post']);
  });

  test('a name in the groups map that matches no resource is skipped, not rendered as a dead link', () => {
    const nav = adminNav(RESOURCES, { groups: { 'admin.group.content': ['ghost', 'post'] } });
    expect(nav[0]?.items.map((item) => item.key)).toEqual(['post']);
  });

  test('a resource placed by the map is not ALSO appended under its own group', () => {
    const nav = adminNav([POST], { groups: { 'admin.group.content': ['post'] } });
    expect(nav).toHaveLength(1);
    expect(nav[0]?.key).toBe('admin.group.content');
  });

  test('extra items are appended to the group they name', () => {
    const ops: NavItem & { readonly group: string } = {
      key: '/ops',
      labelKey: 'admin.ops.title',
      href: '/ops',
      entity: null,
      permissions: ['admin:read', 'ops:read'],
      group: 'admin.group.data',
    };
    const nav = adminNav([POST], { extra: [ops] });
    expect(nav[0]?.items.map((item) => item.key)).toEqual(['post', '/ops']);
  });

  test('an extra item in a group nothing else uses creates that group', () => {
    const nav = adminNav([POST], {
      extra: [
        {
          key: '/health',
          labelKey: 'admin.health.title',
          href: '/health',
          entity: null,
          group: 'admin.group.ops',
        },
      ],
    });
    expect(nav.map((group) => group.key)).toEqual(['admin.group.data', 'admin.group.ops']);
  });
});

describe('visibleNav drops what the actor cannot open', () => {
  const nav = adminNav(RESOURCES, {
    extra: [
      {
        key: '/ops',
        labelKey: 'admin.ops.title',
        href: '/ops',
        entity: null,
        permissions: ['admin:read', 'ops:read'],
        group: 'admin.group.data',
      },
    ],
  });

  test('a resource the actor cannot list is gone, and a group that empties out goes with it', () => {
    const ctx = ctxFor(new Set(['admin:read', 'post:read', 'ops:read']));
    const visible = visibleNav(nav, RESOURCES, ctx);

    expect(visible.map((group) => group.key)).toEqual(['admin.group.data']);
    expect(visible[0]?.items.map((item) => item.key)).toEqual(['post', '/ops']);
  });

  test('a custom page is gated by its OWN permissions — it has no entity to gate on', () => {
    // Without `permissions`, an item with `entity: null` was visible to everyone, which put a
    // link to an ops screen in the sidebar of an actor the page itself refuses.
    const ctx = ctxFor(new Set(['admin:read', 'post:read']));
    const visible = visibleNav(nav, RESOURCES, ctx);
    expect(visible[0]?.items.map((item) => item.key)).toEqual(['post']);
    expect(ctx.asked.map((query) => query.permission)).toContain('ops:read');
  });

  test('an item with no entity and no permissions is a built-in page, always shown', () => {
    const dashboard = adminNav([], {
      extra: [
        {
          key: 'dashboard',
          labelKey: 'admin.dashboard.title',
          href: '/',
          entity: null,
          group: 'admin.group.data',
        },
      ],
    });
    const visible = visibleNav(dashboard, [], ctxFor(new Set()));
    expect(visible[0]?.items.map((item) => item.key)).toEqual(['dashboard']);
  });

  test('an item naming an entity with no resource behind it is dropped, never rendered blind', () => {
    const orphan = adminNav([], {
      extra: [
        {
          key: 'ghost',
          labelKey: 'admin.ghost.title',
          href: '/ghosts',
          entity: 'ghost',
          group: 'admin.group.data',
        },
      ],
    });
    expect(visibleNav(orphan, RESOURCES, ctxFor(new Set(['admin:read', 'ghost:read'])))).toEqual(
      [],
    );
  });

  test('nothing visible at all is an empty nav, not a sidebar of empty groups', () => {
    expect(visibleNav(nav, RESOURCES, ctxFor(new Set()))).toEqual([]);
  });

  test('the gate is the resource’s own list operation — both permissions, in order', () => {
    const ctx = ctxFor(
      new Set(['admin:read', 'post:read', 'tag:read', 'invoice:read', 'ops:read']),
    );
    visibleNav(adminNav([POST]), [POST], ctx);
    expect(ctx.asked.map((query) => query.permission)).toEqual(['admin:read', 'post:read']);
  });
});
