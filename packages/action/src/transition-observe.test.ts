// The recording view a transition's rule is handed: what it reads is what the move pins, so a
// read it misses is a column a concurrent writer may change unseen, and a read it invents is a
// move refused for nothing.

import { describe, expect, test } from 'bun:test';
import { observeRow, takeObservation } from './transition-observe';

describe('observeRow / takeObservation', () => {
  test('records the properties read, and hands back the RAW row once', () => {
    const input = { id: 'p1' };
    const row = { id: 'p1', authorId: 'u1', title: 't' };
    const seen = observeRow(input, row);
    expect(seen?.authorId).toBe('u1');
    expect('title' in (seen ?? {})).toBe(true);
    const observed = takeObservation(input);
    expect(observed?.row).toBe(row);
    expect(observed?.read).toEqual(['authorId', 'title']);
    // Taken once: a second move on the same input object pins nothing stale.
    expect(takeObservation(input)).toBeUndefined();
  });

  test('a rule that enumerates the row may have looked at all of it, so all of it is recorded', () => {
    const input = {};
    const seen = observeRow(input, { id: 'p1', authorId: 'u1' });
    expect({ ...seen }).toEqual({ id: 'p1', authorId: 'u1' });
    expect(takeObservation(input)?.read).toEqual(['id', 'authorId']);
  });

  test('symbols and the thenable probe are not reads of the row', async () => {
    const input = {};
    const seen = await Promise.resolve(observeRow(input, { authorId: 'u1' }));
    expect(String(seen?.[Symbol.toStringTag as never])).toBe('undefined');
    expect(takeObservation(input)?.read).toEqual([]);
  });

  test('a null row is remembered as null, and is handed to the rule unchanged', () => {
    const input = {};
    expect(observeRow(input, null)).toBeNull();
    expect(takeObservation(input)).toEqual({ row: null, read: [] });
  });

  test('two invocations never share an observation', () => {
    const first = {};
    const second = {};
    expect(observeRow(first, { authorId: 'a' })?.authorId).toBe('a');
    observeRow(second, { authorId: 'b' });
    expect(takeObservation(second)?.read).toEqual([]);
    expect(takeObservation(first)?.read).toEqual(['authorId']);
  });
});
