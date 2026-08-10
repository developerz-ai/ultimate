// adminResource() derives a full CRUD surface from a real entity() with zero config, and every
// override or unsupported shape — a hidden label field, an exotic column kind, a composite
// primary key — fails loudly with the fix line instead of guessing or silently narrowing.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  boolean,
  clearRegistry,
  entity,
  enumerated,
  money,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { AdminFieldUnsupportedError } from './errors';
import type { AdminColumnMeta, AdminEntity } from './registry';
import { adminResource, resourceFor } from './resource';

const authors = entity('admin_res_author', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});

const post = entity('admin_res_post', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id),
    slug: text({ max: 64 }).unique(),
    title: text({ max: 120 }),
    body: text(),
    status: enumerated(['draft', 'published']).default('draft'),
    published: boolean(),
    publishedAt: timestamp().nullable(),
    price: money(),
    secret: text({ max: 64 }).nullable(),
    createdAt: timestamp().defaultNow(),
  },
});

/** Composite: neither column says `.primaryKey()`; the entity names both, mirroring the
 * `plans` fixture in `entity-columns.test.ts` under this package's own entity names. */
const plans = entity('admin_res_plan', {
  columns: {
    code: enumerated(['free', 'pro']),
    currency: enumerated(['EUR', 'USD']),
    monthly: money(),
  },
  primaryKey: ['code', 'currency'],
});

afterAll(clearRegistry);

/** Only this package can say a column is secret — an entity has no such flag. */
const HIDES_SECRET = { fields: { secret: { sensitive: true } } } as const;

describe('adminResource with zero config', () => {
  const resource = adminResource(post, HIDES_SECRET);

  test('derives every field from the entity columns', () => {
    expect(resource.fields.map((field) => field.name)).toEqual(Object.keys(post.$columns));
    expect(resource.name).toBe('admin_res_post');
    expect(resource.path).toBe('/admin_res_posts');
    expect(resource.titleKey).toBe('admin.admin_res_post.title');
    expect(resource.idField).toBe('id');
    expect(resource.labelField).toBe('title');
  });

  test('maps each column kind to its one widget', () => {
    expect(resource.field('title').widget).toBe('text-input');
    expect(resource.field('body').type).toBe('textarea');
    expect(resource.field('price').widget).toBe('money');
    expect(resource.field('status').widget).toBe('select');
    expect(resource.field('status').values).toEqual(['draft', 'published']);
    expect(resource.field('published').widget).toBe('checkbox');
    expect(resource.field('publishedAt').widget).toBe('datetime');
    expect(resource.field('authorId').widget).toBe('reference');
    expect(resource.field('authorId').relation).toEqual({
      entity: 'admin_res_author',
      labelField: 'id',
    });
  });

  test('labels are i18n keys, never strings', () => {
    for (const field of resource.fields) {
      expect(field.labelKey).toBe(`admin.admin_res_post.field.${field.name}`);
    }
  });

  test('filters come from indexed, unique, enum, boolean and FK columns only', () => {
    const filters = resource.filters.map((field) => field.name);
    expect(filters).toContain('slug');
    expect(filters).toContain('status');
    expect(filters).toContain('published');
    expect(filters).toContain('authorId');
    // Unindexed text: offering it as a filter would offer a table scan.
    expect(filters).not.toContain('title');
    expect(filters).not.toContain('body');
  });

  test('list columns lead with the label field and stay under the width cap', () => {
    expect(resource.listFields.length).toBeLessThanOrEqual(6);
    expect(resource.listFields[0]?.name).toBe('title');
    expect(resource.listFields.map((field) => field.name)).not.toContain('body');
    expect(resource.listFields.map((field) => field.name)).not.toContain('secret');
  });

  test('sorts by createdAt desc, and generated columns are read-only', () => {
    expect(resource.defaultSort).toEqual({ field: 'createdAt', direction: 'desc' });
    expect(resource.field('createdAt').readOnly).toBe(true);
    expect(resource.field('id').readOnly).toBe(true);
    // `.default('draft')` is a starting value, not something the database writes.
    expect(resource.field('status').readOnly).toBe(false);
    expect(resource.formFields.map((field) => field.name)).not.toContain('id');
    expect(resource.formFields.map((field) => field.name)).not.toContain('secret');
  });

  test('search uses the text fields, and required follows nullability', () => {
    expect(resource.searchFields.map((field) => field.name)).toEqual(['slug', 'title', 'body']);
    expect(resource.field('title').required).toBe(true);
    expect(resource.field('publishedAt').required).toBe(false);
  });
});

describe('adminResource overrides and failures', () => {
  test('a per-field override wins over the derivation', () => {
    const resource = adminResource(post, {
      fields: { title: { widget: 'textarea', labelKey: 'custom.title' }, price: { hidden: true } },
    });
    expect(resource.field('title').widget).toBe('textarea');
    expect(resource.field('title').labelKey).toBe('custom.title');
    expect(resource.fields.map((field) => field.name)).not.toContain('price');
  });

  test('the label field can be declared, and a hidden one is refused', () => {
    expect(adminResource(post, { labelField: 'slug' }).labelField).toBe('slug');
    expect(() =>
      adminResource(post, { labelField: 'slug', fields: { slug: { hidden: true } } }),
    ).toThrow(AdminFieldUnsupportedError);
  });

  /**
   * Reachable only from a hand-written surface today, which is the point: the admin must fail
   * loudly on a column kind it has never heard of rather than render a blank cell.
   */
  const meta = (over: Partial<AdminColumnMeta>): { $meta: AdminColumnMeta } => ({
    $meta: { kind: 'text', notNull: true, primaryKey: false, unique: false, index: false, ...over },
  });

  const exotic = (kind: string): AdminEntity => ({
    $name: 'admin_res_exotic',
    $primaryKey: ['id'],
    $columns: { id: meta({ kind: 'uuid', primaryKey: true }), value: meta({ kind }) },
    $schema: undefined,
    $describe: () => ({ columns: [] }),
  });

  test('the kinds no builder emits yet still map to their one widget', () => {
    expect(adminResource(exotic('jsonb')).field('value').widget).toBe('json-editor');
    expect(adminResource(exotic('bigint')).field('value').widget).toBe('number-input');
    expect(adminResource(exotic('char')).field('value').widget).toBe('text-input');
  });

  test('an unmapped column kind fails loudly with the fix line', () => {
    expect(() => adminResource(exotic('tsvector'))).toThrow(AdminFieldUnsupportedError);
    try {
      adminResource(exotic('tsvector'));
    } catch (error) {
      const thrown = error as { code: string; fix: string };
      expect(thrown.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
      expect(thrown.fix).toContain('adminResource');
    }
  });

  test('a composite primary key is refused, not silently reduced to its first member', () => {
    expect(() => adminResource(plans)).toThrow(AdminFieldUnsupportedError);
    try {
      adminResource(plans);
    } catch (error) {
      const thrown = error as { code: string; fix: string };
      expect(thrown.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
      expect(thrown.fix).toContain('composite-key support');
    }
  });

  test('an unknown resource name names the registered ones', () => {
    const resource = adminResource(post);
    expect(() => resourceFor([resource], 'comment')).toThrow(/comment/);
  });
});
