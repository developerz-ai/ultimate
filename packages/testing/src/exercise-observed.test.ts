// Two recordings of one primitive's calls, as one: counts summed by identity, lists in order, a
// payload's index shifted past the segments before it.

import { describe, expect, test } from 'bun:test';
import { mergeObserved } from './exercise-observed';
import type { Observed } from './exercise-report';
import { testName } from './test-types';

const call = (rows: number, mail: string): Observed => ({
  statements: rows,
  effects: [
    { kind: 'row', entity: 'notes', op: 'insert', rows },
    { kind: 'network', method: 'POST', host: 'a.test', refused: false },
  ],
  refusedHosts: ['b.test'],
  payloads: [{ path: 'effect.mail[0]', value: mail }],
  shapes: [{ fingerprint: 'notes.insert', count: rows, unexpected: rows }],
});

describe(testName('unit', 'mergeObserved'), () => {
  test('none is the empty recording; one is itself', () => {
    expect(mergeObserved([])).toMatchObject({ statements: 0, effects: [] });
    const one = call(1, 'a');
    expect(mergeObserved([one])).toBe(one);
  });

  test('two calls: rows and shapes summed, network kept per call, payloads reindexed', () => {
    const merged = mergeObserved([call(1, 'first'), call(2, 'second')]);
    expect(merged.statements).toBe(3);
    expect(merged.effects).toEqual([
      { kind: 'row', entity: 'notes', op: 'insert', rows: 3 },
      { kind: 'network', method: 'POST', host: 'a.test', refused: false },
      { kind: 'network', method: 'POST', host: 'a.test', refused: false },
    ]);
    expect(merged.refusedHosts).toEqual(['b.test', 'b.test']);
    expect(merged.payloads).toEqual([
      { path: 'effect.mail[0]', value: 'first' },
      { path: 'effect.mail[1]', value: 'second' },
    ]);
    expect(merged.shapes).toEqual([{ fingerprint: 'notes.insert', count: 3, unexpected: 3 }]);
  });
});
