// `$parse` and the difference between "the caller said nothing" and "the caller said null". A
// nullable column with a declared default had no way to be cleared: `??` read the explicit `null`
// as absence and wrote the default straight back, so `update(id, { status: null })` reported
// success and stored `'draft'`.

import { afterAll, expect, test } from 'bun:test';
import { enumerated, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';

const posts = entity('entity_null_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 40 }),
    // Nullable AND defaulted — the one combination the two readings disagree about.
    status: enumerated(['draft', 'published']).nullable().default('draft'),
    publishedAt: timestamp().nullable(),
  },
});

const ID = '00000000-0000-7000-8000-000000000001';

afterAll(() => {
  clearRegistry();
});

test('an omitted defaulted column takes its default', () => {
  expect(posts.$parse({ id: ID, title: 'a', publishedAt: null }).status).toBe('draft');
});

test('an explicit null clears it — the default is what absence means, not what null means', () => {
  expect(posts.$parse({ id: ID, title: 'a', status: null, publishedAt: null }).status).toBe(null);
});

test('a present undefined is still absence, so a spread of an optional key is unchanged', () => {
  const patch = { id: ID, title: 'a', status: undefined, publishedAt: null };
  expect(posts.$parse(patch).status).toBe('draft');
});

test('insert({ x: null }) on a defaulted nullable column stores null', async () => {
  // Through `tableFor`, because that is where `$parse` runs — `memoryRepo` alone stores the row
  // it was handed and would pass this test with the defect intact.
  const repo = memoryRepo(posts, []);
  const table = tableFor(posts, repo);
  await table.insert({ id: ID, title: 'a', status: null, publishedAt: null });
  expect((await repo.findById(ID))?.status).toBe(null);
});

test('a not-null column with no default still refuses, null or absent alike', () => {
  for (const input of [
    { id: ID, publishedAt: null },
    { id: ID, title: null, publishedAt: null },
  ]) {
    expect(() => posts.$parse(input)).toThrow(/is required and has no default/);
  }
});
