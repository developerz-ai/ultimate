// `like` on the in-memory driver compiles to a RegExp, and a run of `%` used to compile to one
// `.*` per character. An anchored regex with twenty adjacent `.*` groups takes exponential time to
// FAIL, so a filter value forwarded from a search box stalled the process — while Postgres reads
// the same run as one wildcard and answers instantly.

import { afterAll, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { clearRegistry } from './registry';

const posts = entity('repo_like_posts', {
  columns: { id: uuid().primaryKey(), title: text({ max: 200 }) },
});

const ID = '00000000-0000-7000-8000-000000000001';
const rows = [{ id: ID, title: 'a'.repeat(64) }];

afterAll(() => {
  clearRegistry();
});

test('a run of % is one wildcard, and a pattern that cannot match says so at once', async () => {
  const started = Bun.nanoseconds();
  // Twenty wildcards then a character the value does not hold: the shape that never matched and,
  // before the fix, never finished either.
  const found = await memoryRepo(posts, rows).findMany({
    where: [{ column: 'title', op: 'like', value: `${'%'.repeat(20)}z` }],
  });
  const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

  expect(found.rows).toEqual([]);
  // Two orders of magnitude of headroom over the fixed path and many orders below the old one,
  // so this fails on the defect and never on a slow machine.
  expect(elapsedMs).toBeLessThan(500);
});

test('the wildcards still mean what SQL means by them', async () => {
  const repo = memoryRepo(posts, [{ id: ID, title: 'draft: hello' }]);
  const matching = async (value: string): Promise<number> =>
    (await repo.findMany({ where: [{ column: 'title', op: 'like', value }] })).rows.length;

  expect(await matching('draft%')).toBe(1);
  expect(await matching('%hello')).toBe(1);
  expect(await matching('draft_ hello')).toBe(1);
  expect(await matching('hello')).toBe(0);
});
