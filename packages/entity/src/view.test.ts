import { afterAll, describe, expect, test } from 'bun:test';
import { integer, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

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
      expect(String((error as { fix?: string }).fix)).toContain('x entity explain view_test_posts');
    }
  });
});
