import { beforeEach, describe, expect, test } from 'bun:test';
import { id, money, orgId, softDelete, table, text, timestamps } from './columns';
import { type EntitySchema, entity } from './entity';
import { invariant } from './invariants';
import { clearRegistry, describeEntities, getEntity } from './registry';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly priceMinor: bigint;
  readonly priceCurrency: string;
}

// A hand-rolled Standard Schema: the package depends on the interface, not on a vendor.
const postSchema: EntitySchema<Post> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => {
      const row = value as Post;
      return typeof row?.title === 'string'
        ? { value: row }
        : { issues: [{ message: 'title must be a string' }] };
    },
  },
};

const postsTable = table('posts', {
  id: id(),
  orgId: orgId(),
  title: text(),
  ...money('price'),
  ...timestamps(),
  ...softDelete(),
});

const define = () =>
  entity<Post, typeof postsTable.columns>({
    table: postsTable,
    type: postSchema,
    tags: ['tag:feed'],
    invariants: [
      invariant<Post>('title_not_empty', {
        message: 'title must not be empty',
        sql: 'char_length(title) > 0',
        holds: (post) => post.title.length > 0,
      }),
    ],
  });

beforeEach(() => {
  clearRegistry();
});

describe('entity()', () => {
  test('derives its cache tag, tenancy and soft-delete from the declaration', () => {
    const posts = define();
    expect(posts.name).toBe('posts');
    expect(posts.cacheTag).toBe('entity:posts');
    expect(posts.tagFor('abc')).toBe('entity:posts:abc');
    expect(posts.orgScoped).toBe(true);
    expect(posts.softDelete).toBe(true);
    expect(posts.tags).toEqual(['entity:posts', 'tag:feed']);
  });

  test('registers itself and refuses a duplicate name', () => {
    define();
    expect(getEntity('posts')?.tableName).toBe('posts');
    expect(() => define()).toThrow(/X_ENTITY_DUPLICATE|already registered/);
  });

  test('assert() runs the invariants on write', () => {
    const posts = define();
    const row: Post = {
      id: '1',
      orgId: 'o1',
      title: 'hello',
      priceMinor: 100n,
      priceCurrency: 'EUR',
    };
    expect(() => posts.assert(row)).not.toThrow();
    expect(() => posts.assert({ ...row, title: '' })).toThrow(/title_not_empty/);
  });

  test('parse() validates through the Standard Schema interface', () => {
    const posts = define();
    expect(posts.parse({ title: 'ok' })).toEqual({ title: 'ok' } as unknown as Post);
    expect(() => posts.parse({ title: 7 })).toThrow(/X_INVARIANT_VIOLATED|title must be/);
  });

  test('migration() emits the CHECK the database enforces', () => {
    expect(define().migration()).toBe(
      'ALTER TABLE "posts" ADD CONSTRAINT "posts_title_not_empty_check" CHECK (char_length(title) > 0);',
    );
  });
});

describe('describe()', () => {
  test('feeds the manifest with everything a generator needs', () => {
    const posts = define();
    const described = posts.describe();
    expect(described.table).toBe('posts');
    expect(described.orgScoped).toBe(true);
    expect(described.cacheTag).toBe('entity:posts');
    expect(described.invariants[0]?.sql).toBe('char_length(title) > 0');

    const price = described.columns.find((column) => column.property === 'priceMinor');
    expect(price?.kind).toBe('bigint');
    const currency = described.columns.find((column) => column.property === 'priceCurrency');
    expect(currency?.check).toContain('^[A-Z]{3}$');
  });

  test('describeEntities() is sorted so the manifest diffs cleanly', () => {
    define();
    entity({ table: table('apps', { id: id(), key: text() }), type: postSchema as never });
    expect(describeEntities().map((description) => description.name)).toEqual(['apps', 'posts']);
  });
});
