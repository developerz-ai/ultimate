// A live row travels under its RECORD key — the entity's primary key, rendered by the entity's own
// projection — so a live window and every HTTP answer hold one record, never two.

import { describe, expect, test } from 'bun:test';
import { entity, text, uuid } from '@ultimat3/entity';
import { liveRecords } from './live-record-type';

entity('lrt_posts', {
  table: 'lrt_post_rows',
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});
entity('lrt_likes', {
  columns: { postId: uuid(), userId: uuid(), note: text({ max: 10 }) },
  primaryKey: ['postId', 'userId'],
});

describe('liveRecords', () => {
  test('an entity keyed by id: the ENTITY name, and the id as its key', () => {
    const records = liveRecords('lrt_post_rows');
    expect(records.type).toBe('lrt_posts');
    expect(records.key?.({ id: 'p1', title: 'x' })).toBe('p1');
  });

  test('a composite-key entity is keyed by its primary key, not by its id', () => {
    const records = liveRecords('lrt_likes');
    expect(records.type).toBe('lrt_likes');
    const key = records.key?.({ id: 'row-9', postId: 'p1', userId: 'u1', note: '' });
    expect(key).not.toBe('row-9');
    expect(key).toContain('p1');
    expect(key).toContain('u1');
  });

  test('a table no entity owns keeps its own name and its rows keep their id', () => {
    expect(liveRecords('lrt_unowned')).toEqual({ type: 'lrt_unowned', key: null });
  });
});
