// `rowsOf` walks an output schema beside its value and collects every value the schema declares
// as a whole entity row — the derived half of the record envelope, so no action declares
// `records:` (axiom 2). A partial row is never a record: it would overwrite a full one.

import { afterAll, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { hasEntityRows, projectionsIn, rowsOf } from './rows-of';

const posts = entity('rows_of_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    likeCount: integer().default(0),
  },
});

const comments = entity('rows_of_comments', {
  columns: {
    id: uuid().primaryKey(),
    body: text({ max: 500 }),
  },
});

afterAll(() => {
  clearRegistry();
});

const post = (n: number) => ({
  id: `00000000-0000-7000-8000-00000000000${n}`,
  title: `post ${n}`,
  likeCount: n,
});
const comment = { id: '00000000-0000-7000-8000-0000000000c1', body: 'hi' };

/** The wire shape: one type's rows keyed by record key (these entities' key is `id`). */
const byKey = (...rows: readonly { readonly id: string }[]) =>
  Object.fromEntries(rows.map((row) => [row.id, row]));

describe('rowsOf()', () => {
  test('a bare row schema collects the value itself', () => {
    expect(rowsOf(posts.$schema, post(1))).toEqual({ rows_of_posts: byKey(post(1)) });
  });

  test('finds a row at depth: object → array → nullable', () => {
    const output = t.object({
      page: t.object({ items: t.array(posts.$schema.nullable()) }),
      total: t.number,
    });
    const value = { page: { items: [post(1), null, post(2)] }, total: 2 };
    const found = rowsOf(output, value);
    expect(found['rows_of_posts']).toEqual(byKey(post(1), post(2)));
    // The SAME objects, never copies: the store adopts what the handler returned.
    expect(found['rows_of_posts']?.[post(1).id] === value.page.items[0]).toBe(true);
  });

  test('groups two entity types and de-duplicates one record shown twice', () => {
    const output = t.object({
      featured: posts.$schema.optional(),
      feed: t.array(posts.$schema),
      latest: t.nullable(comments.$schema),
    });
    const found = rowsOf(output, { featured: post(1), feed: [post(1), post(2)], latest: comment });
    expect(found).toEqual({
      rows_of_posts: byKey(post(1), post(2)),
      rows_of_comments: byKey(comment),
    });
  });

  test('a union arm is collected only when the value fits that arm', () => {
    const output = t.union(comments.$schema, posts.$schema);
    expect(rowsOf(output, post(3))).toEqual({ rows_of_posts: byKey(post(3)) });
    expect(rowsOf(output, comment)).toEqual({ rows_of_comments: byKey(comment) });
  });

  test('a record of rows is walked by value', () => {
    const output = t.record(posts.$schema);
    expect(rowsOf(output, { a: post(1), b: post(2) })).toEqual({
      rows_of_posts: byKey(post(1), post(2)),
    });
  });

  test('both levels are null-prototype maps, so a key is never an inherited member', () => {
    const found = rowsOf(posts.$schema, post(1));
    expect(Object.getPrototypeOf(found)).toBeNull();
    expect(Object.getPrototypeOf(found['rows_of_posts'])).toBeNull();
    expect(Object.getPrototypeOf(rowsOf(t.string, 'x'))).toBeNull();
    expect(found['rows_of_posts']?.['constructor']).toBeUndefined();
  });

  test('the wire carries the composite record key, not an array index', () => {
    const likes = entity('rows_of_likes', {
      columns: { postId: uuid(), memberId: uuid() },
      primaryKey: ['postId', 'memberId'],
    });
    const like = { postId: post(1).id, memberId: comment.id };
    expect(rowsOf(t.array(likes.$schema), [like])).toEqual({
      rows_of_likes: { [`${like.postId}:${like.memberId}`]: like },
    });
  });

  test('a .pick() of a row is not a record', () => {
    const shape = t.object({ id: t.uuid, title: t.string });
    const partial = shape.pick('id');
    expect(rowsOf(partial, { id: post(1).id })).toEqual({});
    expect(hasEntityRows(partial)).toBe(false);
  });

  test('.omit() and .extend() of a row-shaped object are not records either', () => {
    const shape = t.object({ id: t.uuid, title: t.string, likeCount: t.number });
    expect(rowsOf(shape.omit('likeCount'), post(1))).toEqual({});
    expect(rowsOf(shape.extend({ extra: t.string }), { ...post(1), extra: 'x' })).toEqual({});
  });

  test('a $view is a partial row, not a record', () => {
    expect(rowsOf(posts.$view(['id', 'title']), post(1))).toEqual({});
  });

  test('an unbranded look-alike with the identical shape is not collected', () => {
    const lookAlike = t.object({ id: t.uuid, title: t.string, likeCount: t.number });
    expect(rowsOf(lookAlike, post(1))).toEqual({});
    expect(rowsOf(t.array(lookAlike), [post(1)])).toEqual({});
  });

  test('null, undefined and non-schema inputs answer an empty table', () => {
    expect(rowsOf(posts.$schema, null)).toEqual({});
    expect(rowsOf(t.object({ p: posts.$schema.optional() }), {})).toEqual({});
    expect(rowsOf(undefined, post(1))).toEqual({});
    expect(rowsOf({ node: 'not a node' }, post(1))).toEqual({});
  });

  test('a row missing its key is refused, not silently dropped', () => {
    expect(() => rowsOf(t.array(posts.$schema), [{ title: 'no id' }])).toThrow(
      expect.objectContaining({ code: 'X_RECORD_KEY_MISSING' }),
    );
  });
});

describe('hasEntityRows()', () => {
  test('answers statically, at any depth', () => {
    expect(hasEntityRows(posts.$schema)).toBe(true);
    expect(hasEntityRows(t.object({ a: t.array(t.nullable(posts.$schema)) }))).toBe(true);
    expect(hasEntityRows(t.union(t.string, t.record(comments.$schema)))).toBe(true);
    expect(hasEntityRows(t.object({ a: t.array(t.string) }))).toBe(false);
    expect(hasEntityRows(undefined)).toBe(false);
  });
});

describe('projectionsIn()', () => {
  test('lists each entity an output can carry once, in first-seen order, at any depth', () => {
    const output = t.object({
      post: posts.$schema,
      thread: t.array(t.object({ comment: comments.$schema, again: posts.$schema })),
    });
    expect(projectionsIn(output).map((projection) => projection.type)).toEqual([
      'rows_of_posts',
      'rows_of_comments',
    ]);
  });

  test('an output with no entity row, or no schema at all, has none', () => {
    expect(projectionsIn(t.object({ ok: t.boolean }))).toEqual([]);
    expect(projectionsIn(undefined)).toEqual([]);
  });
});
