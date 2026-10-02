// `related: ['comments']` draws the RELATED resource's own list on a detail page, filtered to this
// row: its columns, its row scope, its policy — no second table definition. And the page's whole
// cost is a statement count, taken at the driver.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  type Driver,
  database,
  entity,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminActor } from './authz';
import type { AdminRouteResponse } from './screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();

/** Every call a table makes to its repository. One entry, one statement. */
const statements: string[] = [];
const counting = (inner: Driver): Driver => ({
  repo: (declared) =>
    new Proxy(inner.repo(declared), {
      get(target, property, receiver) {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== 'function' || typeof property !== 'string') return member;
        return (...args: readonly unknown[]): unknown => {
          statements.push(`${declared.$name}.${property}`);
          return Reflect.apply(member, target, args);
        };
      },
    }),
});

const authors = entity('admin_relr_authors', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});
const posts = entity('admin_relr_posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id),
    title: text({ max: 120 }),
    region: text({ max: 8 }),
  },
});
const notes = entity('admin_relr_notes', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id),
    body: text({ max: 120 }),
  },
});

const db = database({ authors, posts, notes }, { driver: counting(memoryDriver()) });

const admin = defineAdmin({
  basePath: '/relr',
  entities: [authors, posts, notes],
  db,
  resources: {
    admin_relr_authors: { related: ['admin_relr_posts', 'admin_relr_notes'] },
    admin_relr_posts: {
      listFields: ['title', 'authorId', 'region'],
      // The related list is THIS list: an EU operator sees the EU posts of an author, never all.
      rows: (actor) => [{ field: 'region', op: 'eq', value: actor.locale ?? '' }],
    },
  },
});

registerCatalog('en', {
  'admin.admin_relr_authors.title': 'Authors',
  'admin.admin_relr_posts.title': 'POSTS-CARD',
  'admin.admin_relr_notes.title': 'NOTES-CARD',
  'admin.admin_relr_posts.field.title': 'Title',
  'admin.admin_relr_posts.field.authorId': 'AUTHOR-COLUMN',
  'admin.admin_relr_posts.field.region': 'Region',
});

const EU: AdminActor = { id: 'u-eu', roles: ['relr-reader'], locale: 'eu' };
const NO_NOTES: AdminActor = { id: 'u-nn', roles: ['relr-postless'], locale: 'eu' };
let authorId = '';

beforeAll(async () => {
  const grants = ['admin:read', 'admin_relr_authors:read', 'admin_relr_posts:read'];
  defineRoles({
    ...previousRoles,
    'relr-reader': { grants: [...grants, 'admin_relr_notes:read'] },
    // May read authors and posts, and NOT notes: the notes card is left out, not drawn empty.
    'relr-postless': { grants },
  });
  authorId = String((await db.authors.insert({ name: 'Ada' })).id);
  const other = String((await db.authors.insert({ name: 'Grace' })).id);
  await db.posts.insert({ authorId, title: 'Ada in EU', region: 'eu' });
  await db.posts.insert({ authorId, title: 'Ada in US', region: 'us' });
  await db.posts.insert({ authorId: other, title: 'Grace in EU', region: 'eu' });
  await db.notes.insert({ authorId, body: 'A note on Ada' });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions);
  clearRegistry();
});

const ask = (actor: AdminActor, path: string): Promise<{ status: number; html: string }> =>
  runWithContext(
    createContext({ actor: userActor({ id: actor.id, roles: [...(actor.roles ?? [])] }) }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no route at ${path}`);
      const response: AdminRouteResponse = await matched.route.respond({
        ctx: admin.ctx({ actor, requestId: 'relr' }),
        params: matched.params,
        url,
        method: 'GET',
        form: null,
      });
      if (response.kind !== 'document') return { status: 303, html: '' };
      const html = await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx');
      return { status: response.status, html };
    },
  );

describe('unit · related rows are the related resource’s own list, filtered to this row', () => {
  test('its row scope narrows them, and the foreign key every row shares is not a column', async () => {
    const page = await ask(EU, `/relr/admin_relr_authors/${authorId}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('POSTS-CARD');
    expect(page.html).toContain('Ada in EU');
    // Another region's post of the same author — outside `rows(actor)`.
    expect(page.html).not.toContain('Ada in US');
    // Another author's post — outside the filter.
    expect(page.html).not.toContain('Grace in EU');
    expect(page.html).not.toContain('AUTHOR-COLUMN');
    expect(page.html).toContain('A note on Ada');
  });

  test('its policy decides: a resource the actor may not list is left out, never drawn empty', async () => {
    const page = await ask(NO_NOTES, `/relr/admin_relr_authors/${authorId}`);
    expect(page.html).toContain('POSTS-CARD');
    expect(page.html).not.toContain('NOTES-CARD');
    expect(page.html).not.toContain('A note on Ada');
  });

  test('a detail page with 2 related lists and a history card: 4 statements', async () => {
    statements.length = 0;
    await ask(EU, `/relr/admin_relr_authors/${authorId}`);
    // The row; each related list, its row scope inside that one read; one label read for the one
    // target the related rows reference. The history card reads the audit log — no statement
    // against the memory log here, one keyset read against the durable one.
    expect(statements).toEqual([
      'admin_relr_authors.findMany',
      'admin_relr_posts.findMany',
      'admin_relr_notes.findMany',
      'admin_relr_authors.findMany',
    ]);
  });
});

describe('unit · a related name is checked where it is declared', () => {
  test('a name that is not a hasMany of the entity is refused, naming what it may be', () => {
    try {
      defineAdmin({
        basePath: '/relr-bad',
        entities: [authors, posts, notes],
        db,
        resources: { admin_relr_authors: { related: ['comments'] } },
      });
      expect.unreachable('a related name that is no relation was accepted');
    } catch (error) {
      expect(error).toBeUltimateError('X_ADMIN_FIELD_UNSUPPORTED');
      const { cause, fix } = error as { cause: string; fix: string };
      expect(cause).toContain('is not a relation of the entity');
      expect(fix).toContain('may name: admin_relr_notes, admin_relr_posts');
    }
  });

  test('a belongsTo is refused: the foreign key field already links to its row', () => {
    expect(() =>
      defineAdmin({
        basePath: '/relr-belongs',
        entities: [authors, posts, notes],
        db,
        resources: { admin_relr_posts: { related: ['author'] } },
      }),
    ).toThrow(/is a belongsTo/);
  });

  test('a related resource missing from the admin is refused, naming the entity to add', () => {
    expect(() =>
      defineAdmin({
        basePath: '/relr-missing',
        entities: [authors, posts],
        db,
        resources: { admin_relr_authors: { related: ['admin_relr_notes'] } },
      }),
    ).toThrow(/not a resource of this admin/);
  });
});
