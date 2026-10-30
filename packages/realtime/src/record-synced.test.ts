// The synced layer's per-type index: a whole-type read walks its own type's rows, and the index
// follows every way a row arrives (a merge, a restore, a policy's `set`) and leaves (a removal, an
// eviction, a clear) — a key left behind would answer a row that is gone.

import { describe, expect, test } from 'bun:test';
import { recordKey } from './record-key';
import { SyncedLayer } from './record-synced';

const keysOf = (layer: SyncedLayer, type: string): readonly string[] =>
  layer.ofType(type).map(([rk]) => rk);

describe('SyncedLayer.ofType', () => {
  test('answers its own type only, a prefix of another type included', () => {
    const layer = new SyncedLayer();
    layer.merge(recordKey('run', 'a'), { id: 'a' }, 'run');
    layer.merge(recordKey('runs', 'b'), { id: 'b' }, 'runs');
    layer.merge(recordKey('run_events', 'c'), { id: 'c' }, 'run_events');
    layer.restore(recordKey('runs', 'd'), { id: 'd' }, 'runs');
    layer.set(recordKey('runs', 'e'), { id: 'e' });
    expect(keysOf(layer, 'runs')).toEqual(['runs:b', 'runs:d', 'runs:e']);
    expect(keysOf(layer, 'run')).toEqual(['run:a']);
  });

  test('a removed, evicted or cleared row leaves the index with it', () => {
    const layer = new SyncedLayer();
    layer.merge(recordKey('runs', 'a'), { id: 'a' }, 'runs');
    layer.merge(recordKey('runs', 'b'), { id: 'b' }, 'runs');
    layer.merge(recordKey('runs', 'c'), { id: 'c' }, 'runs');
    layer.remove(recordKey('runs', 'a'));
    layer.retain(recordKey('runs', 'b'));
    expect(layer.release(recordKey('runs', 'b'))).toBe(true);
    expect(keysOf(layer, 'runs')).toEqual(['runs:c']);
    // Back after a removal: indexed once, not twice.
    layer.merge(recordKey('runs', 'a'), { id: 'a' }, 'runs');
    layer.merge(recordKey('runs', 'a'), { id: 'a', step: 1 }, 'runs');
    expect(keysOf(layer, 'runs')).toEqual(['runs:c', 'runs:a']);
    layer.clear();
    expect(keysOf(layer, 'runs')).toEqual([]);
    layer.merge(recordKey('runs', 'z'), { id: 'z' }, 'runs');
    expect(keysOf(layer, 'runs')).toEqual(['runs:z']);
  });

  test('a type holding a colon is the type its writer named, not the key split at its first colon', () => {
    const layer = new SyncedLayer();
    const named = '?query:feed';
    layer.merge(recordKey(named, 'p1'), { id: 'p1' }, named);
    layer.restore(recordKey(named, 'p2'), { id: 'p2' }, named);
    layer.merge(recordKey('?query', 'x'), { id: 'x' }, '?query');
    expect(keysOf(layer, named)).toEqual(['?query:feed:p1', '?query:feed:p2']);
    expect(keysOf(layer, '?query')).toEqual(['?query:x']);
    layer.remove(recordKey(named, 'p1'));
    expect(keysOf(layer, named)).toEqual(['?query:feed:p2']);
  });
});
