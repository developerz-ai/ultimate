import { afterAll, describe, expect, test } from 'bun:test';
import { generateMigration } from '@ultimat3/db';
import { enumerated, integer, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import { clearRegistry, describeEntities, getEntity } from './registry';

const orgs = entity('entity_test_orgs', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});

const definePosts = () =>
  entity('entity_test_posts', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid()
        .references(() => orgs.id, { onDelete: 'cascade' })
        .tenant(),
      title: text({ max: 120 }),
      price: money(),
      likeCount: integer().default(0),
      status: enumerated(['draft', 'published']).default('draft'),
      publishedAt: timestamp().nullable(),
      createdAt: timestamp().defaultNow(),
      updatedAt: timestamp().defaultNow().onUpdateNow(),
      deletedAt: timestamp().nullable(),
    },
    tags: ['tag:feed'],
    invariants: (c) => [invariant('title_present', c.title.trimmed().minLength(1))],
    indexes: [
      { on: ['orgId', 'publishedAt'], order: 'desc', where: (c) => c.status.eq('published') },
    ],
  });

const posts = definePosts();

/** The whole point of the rewrite: this type is DERIVED, never declared a second time. */
type Post = typeof posts.$row;

const sample: Post = {
  id: '00000000-0000-7000-8000-000000000001',
  orgId: '00000000-0000-7000-8000-0000000000a1',
  title: 'Tenancy is a column',
  price: { minor: 1900, currency: 'USD' },
  likeCount: 0,
  status: 'published',
  publishedAt: new Date('2026-03-02T13:00:00Z'),
  createdAt: new Date('2026-03-02T13:00:00Z'),
  updatedAt: new Date('2026-03-02T13:00:00Z'),
  deletedAt: null,
};

afterAll(() => {
  clearRegistry();
});

describe('entity()', () => {
  test('derives its cache tag, tenancy and soft delete from the columns', () => {
    expect(posts.$name).toBe('entity_test_posts');
    expect(posts.$cacheTag).toBe('entity:entity_test_posts');
    expect(posts.$tagFor('abc')).toBe('entity:entity_test_posts:abc');
    expect(posts.$tenantColumn).toBe('orgId');
    expect(posts.$softDelete).toBe(true);
    expect(posts.$tags).toEqual(['entity:entity_test_posts', 'tag:feed']);
    expect(posts.$primaryKey).toEqual(['id']);
  });

  test('the row type is derived: parse() fills defaults and validates every column', () => {
    const parsed = posts.$parse({
      orgId: sample.orgId,
      title: 'Money is an integer',
      price: { minor: 1900, currency: 'USD' },
      createdAt: sample.createdAt,
      updatedAt: sample.updatedAt,
    });
    expect(parsed.likeCount).toBe(0);
    expect(parsed.status).toBe('draft');
    expect(parsed.publishedAt).toBeNull();
    // A generated uuid v7 primary key, because the column said so — not because a seed did.
    expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.price.minor).toBe(1900);
    expect(() => posts.$parse({ ...sample, likeCount: 1.5 })).toThrow(/safe integer/);
    expect(() => posts.$parse({ ...sample, price: { minor: 19.5, currency: 'USD' } })).toThrow(
      /float/,
    );
  });

  test('a defaultNow() column omitted from the input is stamped with the current instant', () => {
    // Exercises `defaultValue()`'s non-uuid branch (entity.ts), which reads the clock through
    // `systemClock.now()` rather than an ambient `new Date()`. The clock is frozen under the
    // test preload, so "now" is an exact value, not a range.
    const parsed = posts.$parse({
      orgId: sample.orgId,
      title: 'Stamped by the entity, not the caller',
      price: { minor: 500, currency: 'USD' },
    });
    expect(parsed.createdAt).toEqual(new Date());
    expect(parsed.updatedAt).toEqual(new Date());
  });

  test('the columns are on the entity, so a reference is a column and not a string', () => {
    expect(posts.orgId.$meta.tenant).toBe(true);
    expect(orgs.name.$meta.kind).toBe('text');
    expect(posts.$columns.title.$meta.length).toBe(120);
  });

  test('a column may be called view, because every framework member is $-prefixed', () => {
    const widgets = entity('entity_test_widgets', {
      columns: { id: uuid().primaryKey(), view: text(), tenant: text() },
    });
    expect(widgets.view.$meta.kind).toBe('text');
    expect(widgets.tenant.$meta.kind).toBe('text');
    // The column did not shadow the projection, and the projection can pick the column.
    expect(widgets.$view(['id', 'view']).$keys).toEqual(['id', 'view']);
  });

  test('$assert runs the invariants on write', () => {
    expect(() => posts.$assert(sample)).not.toThrow();
    expect(() => posts.$assert({ ...sample, title: '  ' })).toThrow(/title_present/);
  });

  test('$schema is the Standard Schema the columns already describe', () => {
    const result = posts.$schema['~standard'].validate({ ...sample, title: 7 });
    expect(result).not.toBeInstanceOf(Promise);
    expect('issues' in result && result.issues?.[0]?.message).toContain('string');
  });

  test('a composite primary key is declared once, on the entity', () => {
    const likes = entity('entity_test_likes', {
      columns: { postId: uuid(), memberId: uuid(), createdAt: timestamp().defaultNow() },
      primaryKey: ['postId', 'memberId'],
    });
    expect(likes.$primaryKey).toEqual(['postId', 'memberId']);
    expect(likes.$describe().primaryKey).toEqual(['post_id', 'member_id']);
  });

  test('an entity with no key at all is a declaration error', () => {
    expect(() => entity('entity_test_keyless', { columns: { name: text() } })).toThrow(
      /primary key/,
    );
  });

  test('registers itself and refuses a duplicate name', () => {
    expect(getEntity('entity_test_posts')?.tableName).toBe('entity_test_posts');
    expect(() => definePosts()).toThrow(/X_ENTITY_DUPLICATE|already registered/);
  });

  test('a column object belongs to one table, so a shared one is refused', () => {
    const shared = text();
    entity('entity_test_a', { columns: { id: uuid().primaryKey(), label: shared } });
    expect(() =>
      entity('entity_test_b', { columns: { id: uuid().primaryKey(), label: shared } }),
    ).toThrow(/already bound/);
  });
});

describe('describe()', () => {
  test('feeds the manifest with everything a generator needs', () => {
    const described = posts.$describe();
    expect(described.table).toBe('entity_test_posts');
    expect(described.orgScoped).toBe(true);
    expect(described.cacheTag).toBe('entity:entity_test_posts');
    expect(described.invariants[0]?.sql).toBe('char_length(btrim(title)) >= 1');
    expect(described.columns.find((column) => column.property === 'orgId')?.references).toBe(
      'entity_test_orgs.id',
    );
    // Money is two columns in the database and one property on the row.
    expect(described.columns.find((column) => column.property === 'priceMinor')?.kind).toBe(
      'bigint',
    );
    expect(
      described.columns.find((column) => column.property === 'priceCurrency')?.check,
    ).toContain('^[A-Z]{3}$');
    // Carried whole, never reduced to the name: `<table>_<a>_<b>_idx` is one string for two
    // columns and the generator cannot read it back into a column list.
    expect(described.indexes).toEqual([
      {
        name: 'entity_test_posts_org_id_idx',
        columns: ['org_id'],
        unique: false,
        where: null,
        order: null,
      },
      {
        name: 'entity_test_posts_org_id_published_at_idx',
        columns: ['org_id', 'published_at'],
        unique: false,
        where: "status = 'published'",
        order: 'desc',
      },
    ]);
  });

  test('a partial index carries the predicate the app also runs', () => {
    const index = posts.$indexes.find((entry) => entry.columns.includes('published_at'));
    expect(index?.where).toBe("status = 'published'");
    expect(index?.order).toBe('desc');
  });

  test('an index naming no column is refused where it was written', () => {
    expect(() =>
      entity('entity_test_empty_index', {
        columns: { id: uuid().primaryKey() },
        indexes: [{ on: [] }],
      }),
    ).toThrow('an index must name at least one column');
  });

  test('the declared index reaches the generated DDL with every column on it', () => {
    // The whole chain, without a server: entity() -> $describe() -> generateMigration(). A
    // column list recovered from the index name emitted `("org_id_published_at")` — `42703`.
    const migration = generateMigration({
      entities: [posts.$describe()],
      name: 'create posts',
      now: new Date('2026-08-12T00:00:00.000Z'),
    });
    expect(migration.up).toContain(
      'create index "entity_test_posts_org_id_published_at_idx" on "entity_test_posts" ' +
        `("org_id" desc, "published_at" desc) where (status = 'published');`,
    );
  });

  test('describeEntities() is sorted so the manifest diffs cleanly', () => {
    const names = describeEntities().map((description) => description.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('entity_test_posts');
  });
});
