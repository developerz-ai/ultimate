import { describe, expect, test } from 'bun:test';
import { AdminFieldUnsupportedError } from './errors';
import type { AdminEntity } from './registry';
import { adminResource, resourceFor } from './resource';

const post: AdminEntity = {
  name: 'post',
  table: 'posts',
  columns: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'varchar', index: true },
    body: { type: 'text', nullable: true },
    price: { type: 'numeric', currency: 'EUR', nullable: true },
    status: { type: 'varchar', values: ['draft', 'published'] },
    published: { type: 'boolean' },
    publishedAt: { type: 'timestamptz', nullable: true },
    authorId: { type: 'uuid', references: { entity: 'user', column: 'name' } },
    meta: { type: 'jsonb', nullable: true },
    secret: { type: 'varchar', sensitive: true, nullable: true },
    createdAt: { type: 'timestamptz', generated: true },
  },
};

describe('adminResource with zero config', () => {
  const resource = adminResource(post);

  test('derives every field from the entity columns', () => {
    expect(resource.fields.map((field) => field.name)).toEqual(Object.keys(post.columns));
    expect(resource.name).toBe('post');
    expect(resource.path).toBe('/posts');
    expect(resource.titleKey).toBe('admin.post.title');
    expect(resource.idField).toBe('id');
    expect(resource.labelField).toBe('title');
  });

  test('maps each column kind to its one widget', () => {
    expect(resource.field('title').widget).toBe('text-input');
    expect(resource.field('body').type).toBe('textarea');
    expect(resource.field('price').widget).toBe('money');
    expect(resource.field('price').currency).toBe('EUR');
    expect(resource.field('status').widget).toBe('select');
    expect(resource.field('status').values).toEqual(['draft', 'published']);
    expect(resource.field('published').widget).toBe('checkbox');
    expect(resource.field('publishedAt').widget).toBe('datetime');
    expect(resource.field('meta').widget).toBe('json-editor');
    expect(resource.field('authorId').widget).toBe('reference');
    expect(resource.field('authorId').relation).toEqual({ entity: 'user', labelField: 'name' });
  });

  test('labels are i18n keys, never strings', () => {
    for (const field of resource.fields) {
      expect(field.labelKey).toBe(`admin.post.field.${field.name}`);
    }
  });

  test('filters come from indexed, unique, enum, boolean and FK columns only', () => {
    const filters = resource.filters.map((field) => field.name);
    expect(filters).toContain('title');
    expect(filters).toContain('status');
    expect(filters).toContain('published');
    expect(filters).toContain('authorId');
    expect(filters).not.toContain('body');
  });

  test('list columns lead with the label field and stay under the width cap', () => {
    expect(resource.listFields.length).toBeLessThanOrEqual(6);
    expect(resource.listFields[0]?.name).toBe('title');
    expect(resource.listFields.map((field) => field.name)).not.toContain('meta');
    expect(resource.listFields.map((field) => field.name)).not.toContain('secret');
  });

  test('sorts by createdAt desc, and generated columns are read-only', () => {
    expect(resource.defaultSort).toEqual({ field: 'createdAt', direction: 'desc' });
    expect(resource.field('createdAt').readOnly).toBe(true);
    expect(resource.field('id').readOnly).toBe(true);
    expect(resource.formFields.map((field) => field.name)).not.toContain('id');
    expect(resource.formFields.map((field) => field.name)).not.toContain('secret');
  });

  test('search uses the text fields, and required follows nullability', () => {
    expect(resource.searchFields.map((field) => field.name)).toEqual(['title', 'body']);
    expect(resource.field('title').required).toBe(true);
    expect(resource.field('body').required).toBe(false);
  });
});

describe('adminResource overrides and failures', () => {
  test('a per-field override wins over the derivation', () => {
    const resource = adminResource(post, {
      fields: { title: { widget: 'textarea', labelKey: 'custom.title' }, meta: { hidden: true } },
    });
    expect(resource.field('title').widget).toBe('textarea');
    expect(resource.field('title').labelKey).toBe('custom.title');
    expect(resource.fields.map((field) => field.name)).not.toContain('meta');
  });

  test('an unmapped column type fails loudly with the fix line', () => {
    const weird: AdminEntity = {
      name: 'weird',
      columns: { id: { type: 'uuid', primaryKey: true }, vector: { type: 'tsvector' } },
    };
    expect(() => adminResource(weird)).toThrow(AdminFieldUnsupportedError);
    try {
      adminResource(weird);
    } catch (error) {
      const thrown = error as { code: string; fix: string };
      expect(thrown.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
      expect(thrown.fix).toContain('adminResource');
    }
  });

  test('an unknown resource name names the registered ones', () => {
    const resource = adminResource(post);
    expect(() => resourceFor([resource], 'comment')).toThrow(/comment/);
  });
});
