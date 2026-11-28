// The board's columns and its one drop rule: every status a column, in order; a published post,
// or a drop on Published, is refused before any request — `publishPost` owns that move.

import { expect, test } from 'bun:test';
import { type BoardPost, boardColumns, canMovePost, moveTo, revertMove } from './board-columns';

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

// Two overlapping moves, the first refused. A rollback that restored a whole-board snapshot would
// put B back too (accepted or not) and, if B then failed, restore A's refused move.
test('a refusal reverts only its own post, and only while that post is still where it put it', () => {
  const start = [post('a', 'draft'), post('b', 'draft')];
  const afterA = moveTo(start, 'a', 'scheduled');
  const afterB = moveTo(afterA, 'b', 'scheduled');
  // A is refused while B is in flight: B stays where it is.
  const revertedA = revertMove(afterB, 'a', 'draft', 'scheduled');
  expect(revertedA.map((p) => [p.id, p.status])).toEqual([
    ['a', 'draft'],
    ['b', 'scheduled'],
  ]);
  // B is then refused as well: only B moves back, A's refusal is not undone.
  expect(revertMove(revertedA, 'b', 'draft', 'scheduled').map((p) => p.status)).toEqual([
    'draft',
    'draft',
  ]);
  // A post someone moved on since (a live update, a later move) is not dragged back.
  expect(revertMove([post('a', 'published')], 'a', 'draft', 'scheduled')[0]?.status).toBe(
    'published',
  );
});
