// The admin in the manifest and its contract diff: an admin is a list of resources — each with
// the filters, sorts and scopes its list answers and whether a row scope narrows it — and a list
// of mounted routes with the permissions that gate them. Read off the process's declared admins,
// never imported; a file written before admins were projected stays readable.

import { afterEach, describe, expect, test } from 'bun:test';
import { buildManifest } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixture';
import { manifestJson } from './emit';
import { type AdminFact, isManifest } from './schema';
import { frameworkSources } from './sources';
import { ADMIN_MOUNTS_KEY, declaredAdmins } from './sources-admin';

const posts = (
  over: Partial<AdminFact['resources'][number]> = {},
): AdminFact['resources'][number] => ({
  entity: 'posts',
  path: '/posts',
  filters: ['title', 'status'],
  sorts: ['createdAt'],
  scopes: [
    { name: 'open', default: true, count: true },
    { name: 'mine', default: false, count: false },
  ],
  rowScoped: false,
  sections: [{ title: null, fields: ['title', 'status'] }],
  formGroups: [{ title: null, fields: ['title'] }],
  related: ['comments'],
  actions: [
    {
      name: 'post.publish',
      permission: 'posts:publish',
      destructive: false,
      input: false,
      when: false,
      batch: true,
      threshold: null,
      readonly: false,
      matching: false,
    },
  ],
  ...over,
});

const publish = posts().actions[0] ?? expect.unreachable('the fixture declares an action');

const admin = (over: Partial<AdminFact> = {}): AdminFact => ({
  basePath: '/admin',
  audit: 'memory',
  resources: [posts()],
  routes: [
    { url: '/admin', view: 'dashboard', entity: null, permissions: ['admin:read'] },
    {
      url: '/admin/posts',
      view: 'list',
      entity: 'posts',
      permissions: ['admin:read', 'posts:read'],
    },
  ],
  ...over,
});

const changes = (before: readonly AdminFact[], after: readonly AdminFact[]) =>
  diffManifest(fixtureManifest({ admin: before }), fixtureManifest({ admin: after }))
    .changes.filter((change) => change.path.startsWith('admin'))
    .map((change) => [change.kind, change.path]);

describe('the admin section', () => {
  test('is always written — `[]` for an app that declares none — and sorted for determinism', () => {
    expect(fixtureManifest().admin).toEqual([]);
    const built = buildManifest({
      app: { name: 'acme', version: '1.0.0' },
      admin: [
        admin({
          basePath: '/back-office',
          resources: [posts({ entity: 'users', path: '/users' }), posts()],
          routes: [...admin().routes].reverse(),
        }),
        admin(),
      ],
    });
    expect(built.admin?.map((one) => one.basePath)).toEqual(['/admin', '/back-office']);
    expect(built.admin?.[1]?.resources.map((one) => one.entity)).toEqual(['posts', 'users']);
    expect(built.admin?.[1]?.routes.map((one) => one.url)).toEqual(['/admin', '/admin/posts']);
    // Declaration order is kept where it MEANS something: tabs and filters are drawn in it, and a
    // route's permissions are a pair with the coarse gate first.
    expect(built.admin?.[0]?.resources[0]?.scopes.map((scope) => scope.name)).toEqual([
      'open',
      'mine',
    ]);
    expect(built.admin?.[0]?.routes[1]?.permissions).toEqual(['admin:read', 'posts:read']);
    expect(Object.keys(JSON.parse(manifestJson(built)) as object)).toContain('admin');
  });

  test('a file written before admins were projected is readable, and diffs as no admin', () => {
    const { admin: _dropped, ...older } = fixtureManifest();
    expect(isManifest(older)).toBe(true);
    expect(isManifest({ ...older, admin: 'nope' })).toBe(false);
    expect(changes([], [])).toEqual([]);
  });
});

describe('the admin in the contract diff', () => {
  test('a mount, a resource or a route: added is additive, removed is breaking', () => {
    expect(changes([], [admin()])).toEqual([['additive', 'admin./admin']]);
    expect(changes([admin()], [])).toEqual([['breaking', 'admin./admin']]);
    expect(changes([admin()], [admin({ resources: [] })])).toEqual([
      ['breaking', 'admin./admin.resources.posts'],
    ]);
    expect(changes([admin()], [admin({ routes: admin().routes.slice(0, 1) })])).toEqual([
      ['breaking', 'admin./admin.routes./admin/posts'],
    ]);
  });

  test('a filter, a sort or a scope a URL may name: removing one refuses a bookmarked list', () => {
    expect(changes([admin()], [admin({ resources: [posts({ filters: ['title'] })] })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.filters.status'],
    ]);
    expect(
      changes([admin()], [admin({ resources: [posts({ sorts: ['createdAt', 'title'] })] })]),
    ).toEqual([['additive', 'admin./admin.resources.posts.sorts.title']]);
    expect(
      changes([admin()], [admin({ resources: [posts({ scopes: posts().scopes.slice(0, 1) })] })]),
    ).toEqual([['breaking', 'admin./admin.resources.posts.scopes.mine']]);
  });

  test('the default scope moving changes what a bare URL lists; a count is only a query', () => {
    const swapped = posts({
      scopes: [
        { name: 'open', default: false, count: false },
        { name: 'mine', default: true, count: false },
      ],
    });
    expect(changes([admin()], [admin({ resources: [swapped] })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.scopes.mine.default'],
      ['internal', 'admin./admin.resources.posts.scopes.open.count'],
      ['breaking', 'admin./admin.resources.posts.scopes.open.default'],
    ]);
  });

  test('a row scope appearing hides rows from actors who saw them; one going away widens', () => {
    expect(changes([admin()], [admin({ resources: [posts({ rowScoped: true })] })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.rowScoped'],
    ]);
    expect(changes([admin({ resources: [posts({ rowScoped: true })] })], [admin()])).toEqual([
      ['additive', 'admin./admin.resources.posts.rowScoped'],
    ]);
  });

  test('an action is an MCP tool: removed, `ids` withdrawn or `when` appearing refuses a call', () => {
    const withAction = (over: Partial<typeof publish>) =>
      admin({ resources: [posts({ actions: [{ ...publish, ...over }] })] });
    expect(changes([admin()], [admin({ resources: [posts({ actions: [] })] })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.actions.post.publish'],
    ]);
    expect(changes([admin()], [withAction({ when: true })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.actions.post.publish.when'],
    ]);
    expect(changes([admin()], [withAction({ batch: false })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.actions.post.publish.batch'],
    ]);
    expect(changes([withAction({ batch: false })], [admin()])).toEqual([
      ['additive', 'admin./admin.resources.posts.actions.post.publish.batch'],
    ]);
    expect(changes([admin()], [withAction({ input: true, destructive: true })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.actions.post.publish.destructive'],
      ['breaking', 'admin./admin.resources.posts.actions.post.publish.input'],
    ]);
    expect(changes([admin()], [withAction({ permission: 'posts:own' })])).toEqual([
      ['breaking', 'admin./admin.resources.posts.actions.post.publish.permissions.posts:own'],
      ['additive', 'admin./admin.resources.posts.actions.post.publish.permissions.posts:publish'],
    ]);
    expect(changes([admin()], [withAction({ threshold: 100 })])).toEqual([
      ['internal', 'admin./admin.resources.posts.actions.post.publish.threshold'],
    ]);
  });

  // `readonly` and `matching` decide the admin-level gate (`adminPermissionForAction`), and the
  // manifest recorded neither: `admin:read` becoming `admin:write` was invisible to the diff.
  test('the admin gate an action needs: read becoming write refuses a read-only caller', () => {
    const withAction = (over: Partial<typeof publish>) =>
      admin({ resources: [posts({ actions: [{ ...publish, ...over }] })] });
    const at = 'admin./admin.resources.posts.actions.post.publish';
    const reading = withAction({ readonly: true });
    expect(changes([reading], [admin()])).toEqual([
      ['breaking', `${at}.gate`],
      ['internal', `${at}.readonly`],
    ]);
    expect(changes([admin()], [reading])).toEqual([
      ['additive', `${at}.gate`],
      ['internal', `${at}.readonly`],
    ]);
    // `matching` holds the write gate whatever `readonly` says, so gaining it is the same break.
    expect(changes([reading], [withAction({ readonly: true, matching: true })])).toEqual([
      ['breaking', `${at}.gate`],
      ['internal', `${at}.matching`],
    ]);
    // On an action already at the write gate it moves nothing a caller can see.
    expect(changes([admin()], [withAction({ matching: true })])).toEqual([
      ['internal', `${at}.matching`],
    ]);
  });

  test('layout, related lists and the audit log are internal', () => {
    const moved = posts({
      sections: [{ title: 'admin.posts.section.main', fields: ['title'] }],
      related: [],
    });
    expect(changes([admin()], [admin({ resources: [moved], audit: 'postgres' })])).toEqual([
      ['internal', 'admin./admin.audit'],
      ['internal', 'admin./admin.resources.posts.related.comments'],
      ['internal', 'admin./admin.resources.posts.sections'],
    ]);
  });

  test('a route’s permissions are judged like any operation’s', () => {
    const tightened = admin({
      routes: [
        admin().routes[0] ?? expect.unreachable('the fixture has a dashboard route'),
        {
          url: '/admin/posts',
          view: 'list',
          entity: 'posts',
          permissions: ['admin:read', 'posts:audit'],
        },
      ],
    });
    expect(changes([admin()], [tightened])).toEqual([
      ['breaking', 'admin./admin.routes./admin/posts.permissions.posts:audit'],
      ['additive', 'admin./admin.routes./admin/posts.permissions.posts:read'],
    ]);
  });
});

describe('frameworkSources reads the admins this process declared', () => {
  const scope = globalThis as { [key: symbol]: unknown };
  const held = scope[ADMIN_MOUNTS_KEY];

  afterEach(() => {
    if (held === undefined) delete scope[ADMIN_MOUNTS_KEY];
    else scope[ADMIN_MOUNTS_KEY] = held;
  });

  test('none declared is an empty section; an injected one wins over the registry', () => {
    delete scope[ADMIN_MOUNTS_KEY];
    expect(declaredAdmins()).toEqual([]);
    expect(frameworkSources({ app: { name: 'a', version: '1.0.0' } }).admin).toEqual([]);
    expect(
      frameworkSources({ app: { name: 'a', version: '1.0.0' }, admin: [admin()] }).admin,
    ).toEqual([admin()]);
  });

  test('a declared admin is read through its own describe(), field by field', () => {
    scope[ADMIN_MOUNTS_KEY] = new Map([
      [
        '/admin',
        // More than the manifest publishes: a key the description grows is not copied blind.
        { describe: () => ({ ...admin(), secret: 'not a fact' }) },
      ],
      // Not an admin at all: skipped, never a throw out of `x manifest`.
      ['/broken', { describe: 'nope' }],
      ['/worse', null],
    ]);
    expect(declaredAdmins()).toEqual([admin()]);
  });

  test('a description that is not the shape is skipped whole, not half-read', () => {
    scope[ADMIN_MOUNTS_KEY] = new Map([
      ['/admin', { describe: () => ({ basePath: '/admin', resources: 'many', routes: [] }) }],
      ['/half', { describe: () => ({ ...admin(), routes: [{ url: 7 }] }) }],
    ]);
    expect(declaredAdmins()).toEqual([]);
  });
});
