// `entity({ retain })` is checked where it is written: a window is required and must parse, `on` is
// an indexed `timestamp()`, `appendOnly` beside it is refused, and the description carries the
// physical column a purge sweeps by.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

let seq = 0;
const declare = (init: Record<string, unknown>): string => {
  seq += 1;
  try {
    entity(`rt_${seq}`, {
      columns: { id: uuid().primaryKey(), body: text(), createdAt: timestamp().defaultNow() },
      ...init,
    });
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
  return 'accepted';
};
const indexed = { indexes: [{ on: ['createdAt'] }] };

describe('retain · declaration', () => {
  test('a window, an indexed timestamp: accepted, and described physically', () => {
    const events = entity('rt_events', {
      columns: { id: uuid().primaryKey(), createdAt: timestamp().defaultNow() },
      indexes: [{ on: ['createdAt'] }],
      retain: { after: '90d', on: 'createdAt' },
    });
    expect(events.$retain?.afterMs).toBe(90 * 86_400_000);
    expect(events.$describe().retain).toEqual({ after: '90d', on: 'created_at' });
  });

  test.each([
    [
      'no window',
      { retain: { after: '', on: 'createdAt' }, ...indexed },
      'X_ENTITY_RETAIN_INVALID',
    ],
    [
      'a bare number',
      { retain: { after: '90', on: 'createdAt' }, ...indexed },
      'X_ENTITY_RETAIN_INVALID',
    ],
    [
      'not a timestamp',
      { retain: { after: '9d', on: 'body' }, indexes: [{ on: ['body'] }] },
      'X_ENTITY_RETAIN_INVALID',
    ],
    ['no index', { retain: { after: '9d', on: 'createdAt' } }, 'X_ENTITY_RETAIN_UNINDEXED'],
    [
      'beside appendOnly',
      { retain: { after: '9d', on: 'createdAt' }, appendOnly: true, ...indexed },
      'X_ENTITY_RETAIN_INVALID',
    ],
  ])('%s is refused', (_name, init, code) => {
    expect(declare(init)).toBe(code);
  });
});
