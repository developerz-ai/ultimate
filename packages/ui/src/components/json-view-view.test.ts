// The JSON tree: order as given, depth capped, cycles named, non-JSON values as text, wide
// containers folded — and never a throw on content.

import { expect, test } from 'bun:test';
import { JSON_VIEW_MAX_DEPTH, JSON_VIEW_MAX_ENTRIES, jsonViewTree } from './json-view-view';

test('keys keep the order they were given', () => {
  const tree = jsonViewTree({ z: 1, a: 'x', m: [true, null] });
  expect(tree.kind === 'object' ? tree.entries.map(([key]) => key) : []).toEqual(['z', 'a', 'm']);
});

test('a cycle is named, not followed', () => {
  const loop: Record<string, unknown> = { name: 'a' };
  loop['self'] = loop;
  const tree = jsonViewTree(loop);
  expect(tree.kind === 'object' ? tree.entries[1]?.[1] : null).toEqual({ kind: 'circular' });
});

test('a shared, non-cyclic object is drawn twice', () => {
  const shared = { x: 1 };
  const tree = jsonViewTree([shared, shared]);
  expect(tree.kind === 'array' ? tree.entries.map(([, node]) => node.kind) : []).toEqual([
    'object',
    'object',
  ]);
});

test('depth past the cap stops', () => {
  let deep: unknown = 'leaf';
  for (let i = 0; i < JSON_VIEW_MAX_DEPTH + 5; i += 1) deep = [deep];
  let node = jsonViewTree(deep);
  let depth = 0;
  while (node.kind === 'array') {
    node = node.entries[0]?.[1] ?? node;
    depth += 1;
  }
  expect(node).toEqual({ kind: 'deep' });
  expect(depth).toBe(JSON_VIEW_MAX_DEPTH);
});

test('values JSON cannot hold print as text', () => {
  expect(jsonViewTree(10n)).toEqual({ kind: 'other', value: '10' });
  expect(jsonViewTree(Number.NaN)).toEqual({ kind: 'number', value: 'null' });
  expect(jsonViewTree(new Date(0))).toEqual({ kind: 'string', value: '1970-01-01T00:00:00.000Z' });
});

test('a wide array folds past the entry cap', () => {
  const tree = jsonViewTree(Array.from({ length: JSON_VIEW_MAX_ENTRIES + 3 }, () => 0));
  expect(tree.kind === 'array' ? [tree.entries.length, tree.more] : []).toEqual([
    JSON_VIEW_MAX_ENTRIES,
    3,
  ]);
});
