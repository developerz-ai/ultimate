// The counter's SQL, as text: a `where` reaches the trigger's condition, its `update of` list and
// the recount's truth from ONE compiled predicate, and the recount walks the parent by key range.

import { describe, expect, test } from 'bun:test';
import type { CounterDescriptionLike } from './entity-shape';
import {
  counterTrigger,
  recountBatchSql,
  recountDriftBatchSql,
  recountLockSql,
  recountSql,
  recountWindowSql,
} from './generate-counter';

const plain: CounterDescriptionLike = {
  column: 'like_count',
  key: 'id',
  table: 'likes',
  references: 'post_id',
  softDelete: null,
};
const filtered: CounterDescriptionLike = {
  ...plain,
  where: { sql: `c."kind" = 'up'`, columns: ['kind'] },
};

describe('counter · where', () => {
  test('the trigger counts an image only when the predicate holds over it', () => {
    const body = counterTrigger('posts', filtered).install.join('\n');
    expect(body).toContain(`exists (select from (select old.*) c where c."kind" = 'up')`);
    expect(body).toContain(`exists (select from (select new.*) c where c."kind" = 'up')`);
  });

  test('a change to a predicate column fires the trigger', () => {
    const body = counterTrigger('posts', filtered).install.join('\n');
    expect(body).toContain('after insert or delete or update of "post_id", "kind"');
  });

  test('the truth the recount sets is filtered by the same predicate', () => {
    expect(recountSql('posts', filtered)).toContain(`and (c."kind" = 'up'))`);
  });

  test('no where: the statements are the ones a counter always had', () => {
    const body = counterTrigger('posts', plain).install.join('\n');
    expect(body).not.toContain('exists (select');
    expect(body).toContain('update of "post_id" on');
    expect(recountSql('posts', plain)).not.toContain(' and (');
  });
});

describe('counter · recount by key range', () => {
  test('the window is the next keys past the cursor, ordered, bounded by the batch', () => {
    const first = recountWindowSql('posts', plain, null, 500);
    expect(first.text).toBe(
      'select max(w."key") as "last" from (select p."id"::text as "key" from "posts" p order by p."id" limit $1) w',
    );
    expect(first.values).toEqual([500]);
    const next = recountWindowSql('posts', plain, 'k1', 500);
    expect(next.text).toContain('where p."id" > $1 order by p."id" limit $2');
    expect(next.values).toEqual(['k1', 500]);
  });

  test('the drift read and the repair are confined to one window', () => {
    const drift = recountDriftBatchSql('posts', filtered, 'a', 'z');
    expect(drift.text).toContain('p."id" > $1 and p."id" <= $2');
    expect(drift.text).toContain(`and (c."kind" = 'up')`);
    expect(drift.values).toEqual(['a', 'z']);
    const repair = recountBatchSql('posts', filtered, null, 'z');
    expect(repair.text).toStartWith('update "posts" p set "like_count" = ');
    expect(repair.text).toContain('p."id" <= $1');
    expect(repair.text).not.toContain('>');
    expect(repair.values).toEqual(['z']);
  });

  test('the window is locked first, in key order, the way a counter trigger locks a parent', () => {
    const lock = recountLockSql('posts', plain, 'a', 'z');
    expect(lock.text).toBe(
      'select 1 from "posts" p where p."id" > $1 and p."id" <= $2 order by p."id" for no key update',
    );
    expect(lock.values).toEqual(['a', 'z']);
  });
});
