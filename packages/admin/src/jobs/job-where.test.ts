// The one translation from the admin's predicates to the job store's: every predicate the store
// answers, contradictions as an empty read, and everything else refused by name.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { AdminFilter } from '../registry';
import { bulkWhere, jobWhere } from './job-where';

const f = (field: string, op: AdminFilter['op'], value: AdminFilter['value']): AdminFilter => ({
  field,
  op,
  value,
});

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-ultimate';
  }
  return undefined;
};

describe('jobWhere', () => {
  test('every predicate the store answers lands on its own key', () => {
    const where = jobWhere([
      f('state', 'eq', 'dead'),
      f('queue', 'eq', 'mail'),
      f('name', 'eq', 'send'),
      f('tenantId', 'eq', 'org-a'),
      f('id', 'contains', '019f'),
      f('createdAt', 'gte', '2026-10-01T00:00:00.000Z'),
      f('createdAt', 'lte', '2026-10-02T00:00:00.000Z'),
    ]);
    expect(where).toEqual({
      empty: false,
      filter: {
        state: 'dead',
        queue: 'mail',
        name: 'send',
        tenantId: 'org-a',
        idPrefix: '019f',
        createdFrom: Date.parse('2026-10-01T00:00:00.000Z'),
        // The store's upper bound is exclusive; `lte` keeps its own millisecond.
        createdTo: Date.parse('2026-10-02T00:00:00.000Z') + 1,
      },
    });
  });

  test('gt and lt are the exclusive bounds; two bounds keep the narrower', () => {
    const at = Date.parse('2026-10-01T00:00:00.000Z');
    const where = jobWhere([
      f('createdAt', 'gt', '2026-10-01T00:00:00.000Z'),
      f('createdAt', 'gte', '2026-09-01T00:00:00.000Z'),
      f('createdAt', 'lt', '2026-10-03T00:00:00.000Z'),
      f('createdAt', 'lt', '2026-10-05T00:00:00.000Z'),
    ]);
    expect(where.filter.createdFrom).toBe(at + 1);
    expect(where.filter.createdTo).toBe(Date.parse('2026-10-03T00:00:00.000Z'));
  });

  test('an exact id is a prefix the row is checked against', () => {
    expect(jobWhere([f('id', 'eq', 'abc')])).toEqual({
      empty: false,
      exactId: 'abc',
      filter: { idPrefix: 'abc' },
    });
    // The row scope's id and a search box's prefix narrow to the longer one.
    expect(jobWhere([f('id', 'contains', 'ab'), f('id', 'eq', 'abc')]).filter.idPrefix).toBe('abc');
  });

  test('predicates no row satisfies at once read as empty, never as one of the two', () => {
    expect(jobWhere([f('state', 'eq', 'dead'), f('state', 'eq', 'done')]).empty).toBe(true);
    expect(jobWhere([f('id', 'contains', 'ab'), f('id', 'contains', 'cd')]).empty).toBe(true);
    expect(jobWhere([f('id', 'eq', 'a1'), f('id', 'eq', 'a2')]).empty).toBe(true);
    expect(
      jobWhere([
        f('createdAt', 'gte', '2026-10-02T00:00:00.000Z'),
        f('createdAt', 'lt', '2026-10-01T00:00:00.000Z'),
      ]).empty,
    ).toBe(true);
    expect(jobWhere([f('state', 'eq', 'dead'), f('state', 'eq', 'dead')]).empty).toBe(false);
  });

  test('anything else is refused by name: an operator, a field, a value, a state', () => {
    for (const where of [
      [f('name', 'contains', 'send')],
      [f('lastError', 'eq', 'x')],
      [f('state', 'eq', 'sleeping')],
      [f('queue', 'in', ['a', 'b'])],
      [f('createdAt', 'gte', 'yesterday')],
    ]) {
      expect(codeOf(() => jobWhere(where))).toBe('X_ADMIN_FILTER_INVALID');
    }
  });
});

describe('bulkWhere', () => {
  test('a state, a queue, a name and a tenant are one bulk call', () => {
    expect(
      bulkWhere([
        f('tenantId', 'eq', 'org-a'),
        f('state', 'eq', 'dead'),
        f('queue', 'eq', 'mail'),
        f('name', 'eq', 'send'),
      ]),
    ).toEqual({ state: 'dead', queue: 'mail', name: 'send', tenantId: 'org-a' });
    expect(bulkWhere([f('state', 'eq', 'dead')])).toEqual({ state: 'dead' });
  });

  test('a contradiction is no call at all', () => {
    expect(bulkWhere([f('state', 'eq', 'dead'), f('state', 'eq', 'done')])).toBeNull();
  });

  test('no state, or a narrowing the store cannot bulk over, is refused', () => {
    expect(codeOf(() => bulkWhere([f('queue', 'eq', 'mail')]))).toBe('X_ADMIN_FILTER_INVALID');
    expect(codeOf(() => bulkWhere([f('state', 'eq', 'dead'), f('id', 'contains', 'ab')]))).toBe(
      'X_ADMIN_FILTER_INVALID',
    );
  });
});
