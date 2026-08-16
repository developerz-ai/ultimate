// The graph is the single hop from a changed tag to everything that must die with it: an edge it
// fails to return is a stale read in a tier nobody was watching, and one it keeps after
// `unregisterDependent` purges what never changed. Both directions are asserted here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  dependentsOf,
  dependentsOfKind,
  graphSize,
  graphSnapshot,
  isolateGraph,
  registerDependent,
  resetGraph,
  unregisterDependent,
} from './graph';
import { tag } from './tags';

// An empty graph is this file's premise, so the per-test reset stays — and the edges a neighbouring
// file registered come back at the end, which no amount of resetting can do.
const restoreGraph = isolateGraph();

beforeEach(() => {
  resetGraph();
});

afterAll(restoreGraph);

describe('registerDependent / dependentsOf', () => {
  test('a dependent shows up for every tag it was registered under', () => {
    const dep = { kind: 'cache-key' as const, id: 'post:list' };
    registerDependent([tag('post'), tag('user')], dep);

    expect(dependentsOf([tag('post')])).toEqual([dep]);
    expect(dependentsOf([tag('user')])).toEqual([dep]);
  });

  test('a row tag also reaches dependents registered on its collection tag', () => {
    const dep = { kind: 'cache-key' as const, id: 'post:list' };
    registerDependent([tag('post')], dep);

    // A row change ('post:1') must invalidate lists of that row ('post').
    expect(dependentsOf([tag('post', '1')])).toEqual([dep]);
  });

  test('a collection-only tag does not reach dependents registered on unrelated row tags', () => {
    const rowDep = { kind: 'cache-key' as const, id: 'post:1' };
    registerDependent([tag('post', '1')], rowDep);

    expect(dependentsOf([tag('post')])).toEqual([]);
  });

  test('de-dupes a dependent registered under multiple matching tags', () => {
    const dep = { kind: 'cache-key' as const, id: 'post:list' };
    registerDependent([tag('post')], dep);
    registerDependent([tag('post', '1')], dep);

    const found = dependentsOf([tag('post', '1')]);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(dep);
  });
});

describe('dependentsOfKind', () => {
  test('filters by kind and returns bare ids', () => {
    registerDependent([tag('post')], { kind: 'cache-key', id: 'post:list' });
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    registerDependent([tag('post')], { kind: 'cdn-path', id: '/feed.xml' });

    expect(dependentsOfKind([tag('post')], 'isr-route')).toEqual(['/blog']);
    expect(dependentsOfKind([tag('post')], 'cdn-path')).toEqual(['/feed.xml']);
    expect(dependentsOfKind([tag('post')], 'live-query')).toEqual([]);
  });
});

describe('unregisterDependent', () => {
  test('removes the dependent from subsequent lookups', () => {
    const dep = { kind: 'cache-key' as const, id: 'post:1' };
    registerDependent([tag('post', '1')], dep);
    expect(dependentsOf([tag('post', '1')])).toEqual([dep]);

    unregisterDependent(dep);
    expect(dependentsOf([tag('post', '1')])).toEqual([]);
  });

  test('leaves siblings under the same tag resolvable, and cleans up empty tag buckets', () => {
    const a = { kind: 'cache-key' as const, id: 'post:list-a' };
    const b = { kind: 'cache-key' as const, id: 'post:list-b' };
    registerDependent([tag('post')], a);
    registerDependent([tag('post')], b);
    expect(graphSize()).toEqual({ tags: 1, dependents: 2 });

    unregisterDependent(a);
    expect(graphSize()).toEqual({ tags: 1, dependents: 1 });
    expect(dependentsOf([tag('post')])).toEqual([b]);

    // Removing the last dependent for a tag drops the (now empty) tag bucket too.
    unregisterDependent(b);
    expect(graphSize()).toEqual({ tags: 0, dependents: 0 });
  });
});

describe('graphSnapshot', () => {
  test('returns tag -> dependents sorted by tag name', () => {
    const userDep = { kind: 'cache-key' as const, id: 'user:list' };
    const postDep = { kind: 'cache-key' as const, id: 'post:list' };
    registerDependent([tag('user')], userDep);
    registerDependent([tag('post')], postDep);

    expect(graphSnapshot()).toEqual([
      { tag: 'post', dependents: [postDep] },
      { tag: 'user', dependents: [userDep] },
    ]);
  });

  test('is empty for a fresh graph', () => {
    expect(graphSnapshot()).toEqual([]);
  });
});

describe('graphSize', () => {
  test('counts distinct tags and distinct dependents as they are registered', () => {
    expect(graphSize()).toEqual({ tags: 0, dependents: 0 });

    registerDependent([tag('post'), tag('user')], { kind: 'cache-key', id: 'a' });
    expect(graphSize()).toEqual({ tags: 2, dependents: 1 });

    registerDependent([tag('post')], { kind: 'cache-key', id: 'b' });
    expect(graphSize()).toEqual({ tags: 2, dependents: 2 });
  });
});

describe('resetGraph', () => {
  test('clears every tag and dependent', () => {
    registerDependent([tag('post')], { kind: 'cache-key', id: 'a' });
    registerDependent([tag('user'), tag('user', '1')], { kind: 'isr-route', id: '/authors' });
    expect(graphSize().dependents).toBeGreaterThan(0);

    resetGraph();

    expect(graphSnapshot()).toEqual([]);
    expect(graphSize()).toEqual({ tags: 0, dependents: 0 });
  });
});

describe('isolateGraph', () => {
  test('puts back exactly what it found, dropping only what was registered after it', () => {
    const neighbour = { kind: 'isr-route' as const, id: '/neighbour' };
    const mine = { kind: 'cache-key' as const, id: 'mine' };
    registerDependent([tag('post'), tag('post', '1')], neighbour);

    const restore = isolateGraph();
    registerDependent([tag('user')], mine);
    resetGraph();
    restore();

    // Every index is back, not just the one `dependentsOf` reads: `graphSize` counts `byTag` and
    // `dependents`, and `unregisterDependent` walking to zero proves `tagsByDependent` too.
    expect(dependentsOf([tag('post')])).toEqual([neighbour]);
    expect(dependentsOf([tag('user')])).toEqual([]);
    expect(graphSize()).toEqual({ tags: 2, dependents: 1 });
    unregisterDependent(neighbour);
    expect(graphSize()).toEqual({ tags: 0, dependents: 0 });
  });

  test('the captured baseline is a copy: a later registration cannot edit it', () => {
    registerDependent([tag('post')], { kind: 'cache-key', id: 'a' });
    const restore = isolateGraph();

    registerDependent([tag('post')], { kind: 'cache-key', id: 'b' });
    restore();

    expect(dependentsOf([tag('post')])).toEqual([{ kind: 'cache-key', id: 'a' }]);
  });
});

describe('dependentId uniqueness', () => {
  test('registering the same {kind, id} twice is one dependent, not two', () => {
    const kind = 'cache-key' as const;
    registerDependent([tag('post')], { kind, id: 'post:list' });
    registerDependent([tag('user')], { kind, id: 'post:list' });

    // Same dependent linked to two tags, but it is one entry in the graph.
    expect(graphSize().dependents).toBe(1);
    expect(dependentsOf([tag('post')])).toEqual([{ kind, id: 'post:list' }]);
    expect(dependentsOf([tag('user')])).toEqual([{ kind, id: 'post:list' }]);

    // Unregistering it removes it from every tag it was linked to, not just the last one.
    unregisterDependent({ kind, id: 'post:list' });
    expect(dependentsOf([tag('post')])).toEqual([]);
    expect(dependentsOf([tag('user')])).toEqual([]);
    expect(graphSize()).toEqual({ tags: 0, dependents: 0 });
  });
});
