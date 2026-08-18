// adminResource() derives a full CRUD surface from a real entity() with zero config, and every
// override or unsupported shape — a hidden label field, an exotic column kind, a composite
// primary key — fails loudly with the fix line instead of guessing or silently narrowing.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  bigint,
  boolean,
  clearRegistry,
  decimal,
  entity,
  enumerated,
  money,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import { adminColumnsOf } from './entity-columns';
import { AdminFieldUnsupportedError } from './errors';
import type { AdminColumnMeta, AdminEntity, AdminFilter, AdminRepo, AdminRow } from './registry';
import { adminResource, resourceFor } from './resource';
import { adminSearch } from './search';

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

/**
 * The shapes a migrated schema arrives with. `externalId` is the interesting one: a uuid that is
 * neither the primary key nor a declared reference, so nothing upstream turns it into a relation
 * and it derives as plain text.
 */
const legacy = entity('admin_res_legacy', {
  columns: {
    id: uuid().primaryKey(),
    externalId: uuid(),
    reference: text({ max: 40 }),
    rate: decimal({ precision: 18, scale: 8 }),
    legacyKey: bigint(),
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

/**
 * MEASURED on Postgres 17 (PGlite), one statement per column type: only `text` and `char` accept a
 * `LIKE`. Every other kind answers `operator does not exist: <type> ~~ unknown`, and `bytea`
 * answers `Invalid input for bytea type`. The driver compiles the admin's `contains` filter to
 * `<column> like $1` with no cast (`packages/entity/src/pg-sql.ts`), so a searchable column of any
 * other kind is a 500 on the admin's search box — not an empty result.
 */
describe('search targets are columns a LIKE can actually run against', () => {
  const resource = adminResource(legacy);

  test('a numeric, a bigint and a bare uuid are not search targets; text still is', () => {
    expect(resource.searchFields.map((field) => field.name)).toEqual(['reference']);
  });

  /**
   * The assertion that would have caught the original defect. A boolean flag on a field is not
   * where this fails — the failure is a `contains` filter reaching the repo, and from there the
   * driver, naming a column no `LIKE` can run against. So this reads the filters the repo was
   * actually handed.
   */
  test('no contains filter is ever emitted against a column that cannot take one', async () => {
    const seen: AdminFilter[] = [];
    const recording: AdminRepo<AdminRow> = {
      list: async (query): Promise<readonly AdminRow[]> => {
        seen.push(...(query.where ?? []));
        return [];
      },
      find: async (): Promise<AdminRow | null> => null,
      create: async (input): Promise<AdminRow> => input,
      update: async (_id, patch): Promise<AdminRow> => patch,
      destroy: async (): Promise<void> => undefined,
    };
    const actor: AdminActor = { id: 'u_1' };
    const authz = staticAuthz(['admin:read', 'admin_res_legacy:read']);
    const ctx: CrudCtx = { actor, authz, audit: memoryAuditLog(), requestId: 'req_1' };

    const result = await adminSearch({
      term: '42',
      resources: [adminResource(legacy, { repo: recording })],
      ctx,
    });

    expect(result.searched).toEqual(['admin_res_legacy']);
    expect(seen).toEqual([{ field: 'reference', op: 'contains', value: '42' }]);
    // Said the other way round, so a future kind that is added to the mapping and forgotten here
    // still trips this: every emitted `contains` names a column of a kind Postgres accepts. Read
    // through `adminColumnsOf`, which is the same flattening the derivation itself reads.
    const kindOf = new Map(adminColumnsOf(legacy).map((column) => [column.name, column.kind]));
    const likeAble = new Set(['text', 'char']);
    for (const filter of seen.filter((one) => one.op === 'contains')) {
      expect([filter.field, likeAble.has(kindOf.get(filter.field) ?? '')]).toEqual([
        filter.field,
        true,
      ]);
    }
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

  test('a column kind maps to exactly one widget, and big integers are not number inputs', () => {
    expect(adminResource(exotic('jsonb')).field('value').widget).toBe('json-editor');
    // Was `number-input`, decided before `bigint()` existed. That column's row value is decimal
    // DIGITS — a JS number loses everything past 2^53 — and `number-input` renders anything that
    // is not a JS number as null, so it blanked the field and saved the blank back over the id.
    // The render → edit → save round trip is asserted against the builder in `fields.test.ts`.
    expect(adminResource(exotic('bigint')).field('value').widget).toBe('text-input');
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
