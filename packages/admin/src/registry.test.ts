// The claim `registry.ts` makes, driven end to end: a real `entity()` result IS an
// `AdminEntity`, and `defineAdmin` derives a working dashboard from one. This is the test that
// was missing while the admin read `entity.columns` — a field no entity has ever had, which
// every hand-written fixture in this package happily supplied.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  entity,
  enumerated,
  money,
  newId,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { defineAdmin } from './admin';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import { adminCreate, adminDetail, adminList, type CrudCtx } from './crud';
import { adminMcpTools } from './mcp-tools';
import { type AdminEntity, type AdminRepo, type AdminRow, readField, rowId } from './registry';

const orgs = entity('admin_reg_org', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});

const posts = entity('admin_reg_post', {
  columns: {
    id: uuid().primaryKey(),
    ownerId: uuid().references(() => orgs.id),
    title: text({ max: 120 }),
    body: text(),
    status: enumerated(['draft', 'published']).default('draft'),
    price: money(),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

/** The compile-time claim, spelled out on a concrete entity. `tsc` checks it; the tests below
 * check that reading it that way actually works. */
const surface: AdminEntity = posts;

const ORG_ID = newId();
const POST_ID = newId();

const row = (over: AdminRow = {}): AdminRow => ({
  id: POST_ID,
  ownerId: ORG_ID,
  title: 'First post',
  body: 'Body',
  status: 'draft',
  price: { minor: 1999n, currency: 'EUR' },
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  ...over,
});

function repoOver(store: Map<string, AdminRow>): AdminRepo<AdminRow> {
  return {
    list: async (): Promise<readonly AdminRow[]> => [...store.values()],
    find: async (id): Promise<AdminRow | null> => store.get(id) ?? null,
    create: async (input): Promise<AdminRow> => {
      const created = { ...input, id: String(input['id'] ?? newId()) };
      store.set(String(created['id']), created);
      return created;
    },
    update: async (id, patch): Promise<AdminRow> => {
      const next = { ...(store.get(id) ?? {}), ...patch };
      store.set(id, next);
      return next;
    },
    destroy: async (id): Promise<void> => void store.delete(id),
  };
}

const actor: AdminActor = { id: 'u_1' };
const GRANTS = ['admin:write', 'admin_reg_post:read', 'admin_reg_post:write'];

const adminOver = (store: Map<string, AdminRow>) =>
  defineAdmin({
    entities: [orgs, posts],
    resources: { admin_reg_post: { repo: repoOver(store) } },
    auth: { actor: (): AdminActor => actor, authz: staticAuthz(GRANTS) },
  });

const ctx = (): CrudCtx => ({
  actor,
  authz: staticAuthz(GRANTS),
  audit: memoryAuditLog(),
  requestId: 'req_1',
});

describe('defineAdmin over entities built by entity()', () => {
  const app = adminOver(new Map([[POST_ID, row()]]));
  const resource = app.resource('admin_reg_post');

  test('the entity surface the admin reads is the one entity() exposes', () => {
    expect(surface.$name).toBe('admin_reg_post');
    expect(Object.keys(surface.$columns)).toContain('title');
    expect(surface.$primaryKey).toEqual(['id']);
  });

  test('every column becomes a field, and the key becomes the row address', () => {
    expect(resource.fields.map((field) => field.name)).toEqual([
      'id',
      'ownerId',
      'title',
      'body',
      'status',
      'price',
      'createdAt',
    ]);
    expect(resource.idField).toBe('id');
    expect(resource.labelField).toBe('title');
    expect(resource.path).toBe('/admin_reg_posts');
  });

  test('widgets follow the column kinds the entity declared', () => {
    expect(resource.field('title').widget).toBe('text-input');
    expect(resource.field('body').widget).toBe('textarea');
    expect(resource.field('status').widget).toBe('select');
    expect(resource.field('price').widget).toBe('money');
    expect(resource.field('createdAt').widget).toBe('datetime');
    expect(resource.field('ownerId').relation).toEqual({
      entity: 'admin_reg_org',
      labelField: 'id',
    });
  });

  test('generated columns are read-only, a defaulted one stays writable', () => {
    expect(resource.field('id').readOnly).toBe(true);
    expect(resource.field('createdAt').readOnly).toBe(true);
    expect(resource.field('status').readOnly).toBe(false);
    expect(resource.formFields.map((field) => field.name)).toEqual([
      'ownerId',
      'title',
      'body',
      'status',
      'price',
    ]);
  });

  test('both entities get their routes, and the nav lists both', () => {
    expect(app.resources.map((each) => each.name)).toEqual(['admin_reg_org', 'admin_reg_post']);
    expect(app.routes.map((route) => route.path)).toContain('/admin/admin_reg_posts/:id');
  });
});

describe('the derived admin reads and writes real rows', () => {
  test('list and detail go through the bound repo', async () => {
    const app = adminOver(new Map([[POST_ID, row()]]));
    const listed = await adminList(app.resource('admin_reg_post'), ctx());
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.page.rows.map((each) => each['title'])).toEqual(['First post']);

    const detail = await adminDetail(app.resource('admin_reg_post'), ctx(), POST_ID);
    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.row?.['title']).toBe('First post');
  });

  test("a create is validated by the entity's own schema, not by a second set of rules", async () => {
    const store = new Map<string, AdminRow>();
    const app = adminOver(store);
    const result = await adminCreate(app.resource('admin_reg_post'), ctx(), {
      ...row({ id: newId() }),
      status: 'archived',
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'invalid') {
      // The entity's own enum, named back — that is what proves this went through `$parse` and
      // not a second rule set the admin invented. Deliberately NOT the rejected value: a refusal
      // reports the shape of what it got, never the content, because that message reaches the log
      // store and the HTTP body, and this column is a text field a caller controls.
      expect(result.issues[0]?.message).toContain('draft | published');
      expect(result.issues[0]?.message).not.toContain('archived');
    }
    expect(store.size).toBe(0);
  });

  test('a valid create lands', async () => {
    const store = new Map<string, AdminRow>();
    const app = adminOver(store);
    const result = await adminCreate(app.resource('admin_reg_post'), ctx(), row({ id: newId() }));

    expect(result.ok).toBe(true);
    expect(store.size).toBe(1);
  });

  test('the MCP tools carry the derived form fields', () => {
    const app = adminOver(new Map());
    const create = adminMcpTools(app, ctx()).find(
      (tool) => tool.name === 'admin.admin_reg_post.create',
    );

    expect(create?.input.map((field) => field.name)).toEqual([
      'ownerId',
      'title',
      'body',
      'status',
      'price',
    ]);
    expect(create?.input.find((field) => field.name === 'price')?.type).toBe('money');
  });
});

describe('the two row readers', () => {
  test('readField reads by name, and an absent column is undefined rather than a throw', () => {
    const record: AdminRow = { id: 'p_1', title: 'Hello', archived: false };
    expect(readField(record, 'title')).toBe('Hello');
    // `false` and `0` must survive: a reader that used `||` would blank them.
    expect(readField(record, 'archived')).toBe(false);
    expect(readField(record, 'nope')).toBeUndefined();
  });

  test('rowId hands back a string id unchanged', () => {
    expect(rowId({ id: 'p_1' }, 'id')).toBe('p_1');
  });

  test('a non-string id is stringified rather than reaching a URL as [object Object]', () => {
    // A legacy `int8` key arrives as a number or as decimal digits; both address a row.
    expect(rowId({ id: 42 }, 'id')).toBe('42');
    expect(rowId({ id: 9007199254740993n }, 'id')).toBe('9007199254740993');
  });

  test('a missing or null id is the empty string, never the words "undefined"/"null"', () => {
    // Those two strings would be pasted straight into `/posts/undefined/edit`.
    expect(rowId({}, 'id')).toBe('');
    expect(rowId({ id: null }, 'id')).toBe('');
  });

  test('the id column is the one named, not a hardcoded "id"', () => {
    expect(rowId({ id: 'p_1', slug: 'hello' }, 'slug')).toBe('hello');
  });
});
