// `refreshView()`'s queue identity: one live refresh per declaration, whatever the input, so a
// second enqueue while one runs is the same refresh — and two views never share a key.

import { afterAll, describe, expect, test } from 'bun:test';
import { bigint, clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { resetJobs } from './job';
import { refreshView } from './refresh-view';

const totals = entity('rv_key_totals', {
  view: {
    sql: 'select post_id, count(*) as total from rv_key_hits group by post_id',
    materialized: true,
  },
  columns: { postId: uuid().unique(), total: bigint() },
  primaryKey: ['postId'],
});

afterAll(() => {
  resetJobs();
  clearRegistry();
});

describe('refreshView', () => {
  test('one idempotency key per declaration, the input playing no part', () => {
    const daily = refreshView({ name: 'rv-key-daily', view: totals });
    const hourly = refreshView({ name: 'rv-key-hourly', view: totals, concurrently: true });
    expect(daily.idempotencyKeyFor({})).toBe('refresh-view:rv-key-daily');
    expect(hourly.idempotencyKeyFor({})).toBe('refresh-view:rv-key-hourly');
  });

  test('a unique EXPRESSION index cannot key a concurrent refresh', () => {
    const lowered = entity('rv_key_lowered', {
      view: { sql: 'select email from rv_key_people', materialized: true },
      columns: { email: text() },
      primaryKey: ['email'],
      indexes: [{ on: ['email'], unique: true, expression: 'lower(email)' }],
    });
    expect(() =>
      refreshView({ name: 'rv-key-lowered', view: lowered, concurrently: true }),
    ).toThrow(/unique index/);
  });
});
