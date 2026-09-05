import { afterAll, describe, expect, test } from 'bun:test';
import { introspect, type MoneyValue, type StandardSchemaV1, toJsonSchema } from '@ultimat3/schema';
import { integer, money, text, timestamp, uuid } from './columns';
import { arrayOf, bigint, date, decimal } from './columns-data';
import { entity } from './entity';
import { enumerated } from './enum-column';
import { clearRegistry } from './registry';
import { viewFor } from './view';

const posts = entity('view_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 120 }),
    excerpt: text({ max: 200 }).nullable(),
    likeCount: integer().default(0),
    publishedAt: timestamp().nullable(),
  },
});

const PostView = posts.$view(['id', 'title', 'excerpt', 'publishedAt']);

/** Hop 4 of the type chain: the action's output type, derived and never written a second time. */
type PostView = typeof PostView.$row;

/** A consumer of the projected type — if `Pick` were wrong, this would not compile. */
const headline = (post: PostView): string => `${post.title}${post.excerpt ?? ''}`;

const row = {
  id: '00000000-0000-7000-8000-000000000001',
  orgId: '00000000-0000-7000-8000-0000000000a1',
  title: 'A view is a projection',
  excerpt: 'not a second declaration',
  likeCount: 3,
  publishedAt: new Date('2026-05-01T10:00:00Z'),
};

/** Every column parser is synchronous, so a Promise here is itself the failure. */
const project = (value: unknown): PostView => {
  const result = PostView['~standard'].validate(value);
  if (result instanceof Promise) throw new Error('a view must validate synchronously');
  if (result.issues !== undefined) throw new Error(result.issues[0]?.message ?? 'rejected');
  return result.value;
};

const issueFor = (value: unknown): string => {
  const result = PostView['~standard'].validate(value);
  if (result instanceof Promise) throw new Error('a view must validate synchronously');
  return result.issues?.[0]?.message ?? '';
};

afterAll(() => {
  clearRegistry();
});

describe('$view()', () => {
  test('projects a row down to exactly the picked keys', () => {
    const projected = project(row);
    expect(Object.keys(projected).sort()).toEqual(['excerpt', 'id', 'publishedAt', 'title']);
    expect(headline(projected)).toBe('A view is a projectionnot a second declaration');
    // Not picked, so not present: a view is the contract, not a filtered copy of the row.
    expect('orgId' in projected).toBe(false);
    expect('likeCount' in projected).toBe(false);
  });

  test('a value is rejected by the column that owns it, not by a second copy of its rule', () => {
    expect(issueFor({ ...row, title: 7 })).toContain('expected a string');
    expect(issueFor({ ...row, id: 'not-a-uuid' })).toContain('expected a uuid');
    expect(issueFor({ ...row, publishedAt: 'yesterday' })).toContain('expected a UTC instant');
    expect(issueFor('a post')).toContain('expected an object');
  });

  test('a nullable column projects null; a required one that is absent is missing data', () => {
    expect(project({ ...row, excerpt: null }).excerpt).toBeNull();
    expect(issueFor({ ...row, title: undefined })).toContain('is required');
  });

  test('a default is never invented: a view projects a row that already exists', () => {
    const counts = posts.$view(['likeCount']);
    const result = counts['~standard'].validate({});
    expect(result).not.toBeInstanceOf(Promise);
    expect('issues' in result && result.issues?.[0]?.message).toContain('is required');
  });

  test('is introspectable, so it can be an action output and reach OpenAPI', () => {
    const columns = {
      id: uuid().primaryKey(),
      title: text({ max: 40 }),
      count: integer().nullable(),
    };
    const view = viewFor<
      { id: string; title: string; count: number | null },
      'id' | 'title' | 'count'
    >('things', columns, ['id', 'title', 'count']);
    const node = introspect(view);
    expect(node.kind).toBe('object');
    expect(node.properties?.['id']).toEqual({ kind: 'string', format: 'uuid' });
    expect(node.properties?.['title']).toEqual({ kind: 'string', maxLength: 40 });
    expect(node.properties?.['count']).toEqual({ kind: 'number', integer: true, nullable: true });
  });

  test('projects to the JSON Schema an action output publishes: money, date, enum, nullable', () => {
    const columns = {
      id: uuid().primaryKey(),
      price: money(),
      publishedAt: timestamp().nullable(),
      status: enumerated(['draft', 'live']),
      views: bigint(),
      rate: decimal(),
      effectiveOn: date(),
      tags: arrayOf(text()),
    };
    type Row = {
      id: string;
      price: MoneyValue;
      publishedAt: Date | null;
      status: 'draft' | 'live';
      views: string;
      rate: string;
      effectiveOn: string;
      tags: readonly string[];
    };
    const view = viewFor<Row, keyof Row>('things', columns, [
      'id',
      'price',
      'publishedAt',
      'status',
      'views',
      'rate',
      'effectiveOn',
      'tags',
    ]);
    const schema = toJsonSchema(view, { includeDialect: false });
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    // Nullable is a value the field holds, never an absent key: still required, `null` in the union.
    expect(schema.required).toEqual([
      'id',
      'price',
      'publishedAt',
      'status',
      'views',
      'rate',
      'effectiveOn',
      'tags',
    ]);
    expect(schema.properties?.['publishedAt']).toEqual({
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    });
    expect(schema.properties?.['status']).toEqual({ type: 'string', enum: ['draft', 'live'] });
    expect(schema.properties?.['price']?.type).toBe('object');
    expect(schema.properties?.['price']?.required).toEqual(['minor', 'currency']);
    expect(schema.properties?.['price']?.properties?.['minor']?.type).toBe('integer');
    // The row value's shape, not the SQL type's: bigint and numeric are strings on a row, and a
    // date column is a calendar-date string, so a generated client agrees with `$parse`.
    expect(schema.properties?.['views']?.type).toBe('string');
    expect(schema.properties?.['views']?.pattern).toBe('^-?\\d+$');
    expect(schema.properties?.['rate']?.type).toBe('string');
    expect(schema.properties?.['effectiveOn']).toEqual({
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'calendar date, YYYY-MM-DD',
    });
    expect(schema.properties?.['tags']).toEqual({ type: 'array', items: { type: 'string' } });
  });

  test('$row is a type, not a value', () => {
    expect(() => PostView.$row).toThrow(/\$row is a type, not a value/);
  });

  test('$name and $keys let a manifest identify the projection', () => {
    expect(PostView.$name).toBe('view_test_posts.view.id_title_excerpt_publishedAt');
    expect(PostView.$keys).toEqual(['id', 'title', 'excerpt', 'publishedAt']);
    // Same keys, same name: a manifest diff has to be about the schema, not about the clock.
    expect(posts.$view(['id', 'title', 'excerpt', 'publishedAt']).$name).toBe(PostView.$name);
    expect(posts.$view(['id', 'title']).$name).toBe('view_test_posts.view.id_title');
  });

  test('it is a Standard Schema, so it drops into action({ output })', () => {
    expect(PostView['~standard'].version).toBe(1);
    expect(PostView['~standard'].vendor).toBe('ultimate');
  });

  test('an unknown key fails at declaration time, naming the columns to pick from', () => {
    // `tsc` already refuses this (hop 4); the runtime has to refuse a dynamic key list too.
    const dynamic = posts.$view as (keys: readonly string[]) => unknown;
    try {
      dynamic(['nope']);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_INVARIANT_VIOLATED');
      expect(String((error as { cause?: string }).cause)).toContain("$view(['nope'])");
      expect(String((error as { cause?: string }).cause)).toContain('title');
      // The fix names the entity, not the view, so the command is one an agent can run.
      expect(String((error as { fix?: string }).fix)).toContain(
        'x entities describe view_test_posts',
      );
    }
  });
});

/**
 * A `~standard` validator answers with `issues`; it does not throw. The two lines that built the
 * issue message read the caught value directly — `error instanceof Error ? error.message :
 * String(error)` — and BOTH halves are reads a throwable can refuse: `instanceof` consults
 * `getPrototypeOf`, `String()` runs the value's own coercion. So a null-prototype throwable out of
 * a column parser raised a second, uncatchable `TypeError` from inside the validator, in place of
 * the rejection the caller asked for. `renderThrowable` is total.
 */
describe('a projection rejected by a throwable that fights being read', () => {
  const viewOver = (thrown: unknown): StandardSchemaV1<unknown, { readonly title: string }> =>
    viewFor<{ title: string }, 'title'>(
      'view_test_hostile',
      {
        title: {
          ...text(),
          $parse: (): never => {
            throw thrown;
          },
        },
      },
      ['title'],
    );

  test('a null-prototype throwable becomes an issue, never a second throw', () => {
    const result = viewOver(Object.assign(Object.create(null), { detail: 'no coercion for you' }))[
      '~standard'
    ].validate({ title: 'anything' });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result instanceof Promise ? [] : (result.issues ?? [])).toHaveLength(1);
  });

  test('a Proxy that refuses every read becomes an issue too', () => {
    const hostile = new Proxy(
      {},
      {
        get: (): never => {
          throw new TypeError('no reads');
        },
        getPrototypeOf: (): never => {
          throw new TypeError('no prototype either');
        },
      },
    );
    const result = viewOver(hostile)['~standard'].validate({ title: 'anything' });
    expect(result).not.toBeInstanceOf(Promise);
    const message = result instanceof Promise ? '' : (result.issues?.[0]?.message ?? '');
    expect(message.length).toBeGreaterThan(0);
  });

  test('an ordinary Error still says what it said, and names its kind', () => {
    const result = viewOver(new TypeError('title is not a string'))['~standard'].validate({
      title: 'anything',
    });
    const message = result instanceof Promise ? '' : (result.issues?.[0]?.message ?? '');
    expect(message).toContain('title is not a string');
    expect(message).toContain('TypeError');
  });
});
