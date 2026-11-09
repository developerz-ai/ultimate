// The board's columns and its one drop rule: every status a column, in order; a published post,
// or a drop on Published, is refused before any request — `publishPost` owns that move.

import { expect, test } from 'bun:test';
import { type BoardPost, boardColumns, canMovePost } from './board-columns';

const LABELS = { draft: 'Draft', scheduled: 'Scheduled', published: 'Published' };
const post = (id: string, status: BoardPost['status']): BoardPost => ({ id, title: id, status });

test('one column per status, in the domain order, each holding its posts', () => {
  const columns = boardColumns([post('a', 'scheduled'), post('b', 'draft')], LABELS);
  expect(columns.map((column) => [column.id, column.items.map((item) => item.id)])).toEqual([
    ['draft', ['b']],
    ['scheduled', ['a']],
    ['published', []],
  ]);
});

test('only draft and scheduled cross, and nothing lands on Published', () => {
  expect(canMovePost(post('a', 'draft'), 'scheduled')).toBe(true);
  expect(canMovePost(post('a', 'scheduled'), 'draft')).toBe(true);
  expect(canMovePost(post('a', 'draft'), 'published')).toBe(false);
  expect(canMovePost(post('a', 'published'), 'draft')).toBe(false);
});
