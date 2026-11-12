// `.all()` answers one page. When a next page existed and the chain never said `.limit(n)`, a
// development or test process says so — once per call, as a `log.record` warning — and staging and
// production say nothing: the refusal is a break, and it waits for `next`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { InstrumentEventMap } from '@ultimat3/core';
import { resetInstrumentation, subscribe } from '@ultimat3/core';
import { ALL_TRUNCATED, reportTruncatedAll } from './all-truncated';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { DEFAULT_PAGE_SIZE } from './plan';
import { clearRegistry } from './registry';

afterEach(() => resetInstrumentation());
afterAll(() => clearRegistry());

type LogRecordEvent = InstrumentEventMap['log.record'];

const heard = (): LogRecordEvent[] => {
  const seen: LogRecordEvent[] = [];
  subscribe('log.record', ({ payload }) => {
    if (payload.message === ALL_TRUNCATED) seen.push(payload);
  });
  return seen;
};

describe('reportTruncatedAll', () => {
  test('a dropped cursor in development warns, naming the entity and both ways out', () => {
    const seen = heard();
    reportTruncatedAll('posts', 'cursor-2', false, { ULTIMATE_ENV: 'development' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.level).toBe('warn');
    expect(seen[0]?.fields).toMatchObject({ entity: 'posts', pageSize: DEFAULT_PAGE_SIZE });
    expect(String(seen[0]?.fields['fix'])).toContain('.inBatches(');
    expect(String(seen[0]?.fields['fix'])).toContain('.limit(');
  });

  test('test warns as development does', () => {
    const seen = heard();
    reportTruncatedAll('posts', 'cursor-2', false, { ULTIMATE_ENV: 'test' });
    expect(seen).toHaveLength(1);
  });

  test.each([
    ['no next page', null, false, 'development'],
    ['the chain said .limit(n)', 'cursor-2', true, 'development'],
    ['staging', 'cursor-2', false, 'staging'],
    ['production', 'cursor-2', false, 'production'],
  ] as const)('silent: %s', (_name, next, limited, environment) => {
    const seen = heard();
    reportTruncatedAll('posts', next, limited, { ULTIMATE_ENV: environment });
    expect(seen).toHaveLength(0);
  });
});

describe('.all() on a chain', () => {
  const notes = entity('truncated_notes', {
    columns: { id: uuid().primaryKey(), title: text({ max: 20 }) },
  });
  const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

  test('one page past the default reports the dropped cursor; .limit(n) does not', async () => {
    const db = database({ notes }, { driver: memoryDriver() });
    await db.notes.insertAll(
      Array.from({ length: DEFAULT_PAGE_SIZE + 1 }, (_, n) => ({ id: id(n), title: `n${n}` })),
    );
    const seen = heard();
    expect(await db.notes.where({}).all()).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(seen.map((record) => record.fields['entity'])).toEqual(['truncated_notes']);
    await db.notes.where({}).limit(10).all();
    expect(seen).toHaveLength(1);
  });
});
