// Every way the scan has into a development import, over graphs built by hand: the ways a search per
// holder would list, found by one pass however many branches and holders share the graph.

import { describe, expect, test } from 'bun:test';
import type { ChainStep, EvaluatedImport } from './evaluated-walk';
import { scanWays } from './scan-ways';

/** `from → to`, in the order each module writes its imports. `reads` counts what a pass looked at. */
function graphOf(pairs: readonly (readonly [string, string])[]): {
  readonly edges: readonly EvaluatedImport[];
  readonly reads: () => number;
} {
  let reads = 0;
  const edges = pairs.map(
    ([from, to], index): EvaluatedImport => ({
      get from() {
        reads += 1;
        return from;
      },
      specifier: `./${to}#${String(index)}`,
      target: () => {
        reads += 1;
        return to;
      },
    }),
  );
  return { edges, reads: () => reads };
}

const paths = (ways: readonly (readonly ChainStep[])[]): string[] =>
  ways.map((way) => way.map((step) => step.path).join(' ')).sort();

/** What `scanWays` must answer, by a search per holder: shortest, and a tie to the first import. */
function oracle(
  pairs: readonly (readonly [string, string])[],
  scanned: ReadonlySet<string>,
  holder: string,
): string[] {
  if (scanned.has(holder)) return [holder];
  const far = new Map([[holder, 0]]);
  for (const [path, distance] of far) {
    for (const [from, to] of pairs) {
      if (to === path && !scanned.has(from) && !far.has(from)) far.set(from, distance + 1);
    }
  }
  const down = (path: string): string[] => {
    if (path === holder) return [path];
    const next = pairs.find(
      ([from, to]) => from === path && far.get(to) === (far.get(path) ?? 0) - 1,
    );
    return [path, ...down(next?.[1] ?? holder)];
  };
  return pairs
    .filter(([from, to]) => scanned.has(from) && far.has(to))
    .map(([from, to]) => [from, ...down(to)].join(' '))
    .sort();
}

describe('the ways into a holder', () => {
  test('a scanned holder is its own way, and an unreached one has none', () => {
    const { edges } = graphOf([['page', 'kit']]);
    const ways = scanWays(['page', 'far'], new Set(['page']), edges);
    expect(ways('page')).toEqual([[{ path: 'page' }]]);
    expect(ways('far')).toEqual([]);
  });

  test('each step carries the specifier that reached it', () => {
    const { edges } = graphOf([
      ['page', 'kit'],
      ['kit', 'deep'],
    ]);
    expect(scanWays(['deep'], new Set(['page']), edges)('deep')).toEqual([
      [
        { path: 'page' },
        { path: 'kit', specifier: './kit#0' },
        { path: 'deep', specifier: './deep#1' },
      ],
    ]);
  });

  test('the shortest way, a tie to the first import, and never through a scanned module', () => {
    const pairs = [
      ['page', 'kit'],
      ['kit', 'long'],
      ['long', 'b'],
      ['kit', 'b'],
      ['kit', 'a'],
      ['a', 'holder'],
      ['b', 'holder'],
      ['page', 'other'],
      ['other', 'mid'],
      ['mid', 'holder'],
    ] as const;
    const scanned = new Set(['page', 'mid']);
    const ways = scanWays(['holder'], scanned, graphOf(pairs).edges)('holder');
    expect(paths(ways)).toEqual(['mid holder', 'page kit b holder']);
    expect(paths(ways)).toEqual(oracle(pairs, scanned, 'holder'));
  });

  test('holders that import each other, at every distance from each other', () => {
    const pairs = [
      ['page', 'a'],
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['page', 'c'],
    ] as const;
    const scanned = new Set(['page']);
    const ways = scanWays(['a', 'b', 'c'], scanned, graphOf(pairs).edges);
    for (const holder of ['a', 'b', 'c']) {
      expect(paths(ways(holder))).toEqual(oracle(pairs, scanned, holder));
    }
  });

  test('two hundred graphs answer what a search per holder answers', () => {
    let state = 7;
    const below = (limit: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((state / 2_147_483_648) * limit);
    };
    for (let graph = 0; graph < 200; graph += 1) {
      const names = Array.from({ length: 4 + below(9) }, (_, index) => `m${String(index)}`);
      const name = (): string => names[below(names.length)] ?? 'm0';
      const seen = new Set<string>();
      const pairs = Array.from(
        { length: names.length * 2 },
        () => [name(), name()] as const,
      ).filter(
        ([from, to]) => from !== to && !seen.has(`${from} ${to}`) && seen.add(`${from} ${to}`),
      );
      const scanned = new Set(names.filter(() => below(3) === 0));
      const ways = scanWays(names, scanned, graphOf(pairs).edges);
      for (const holder of names) {
        expect([graph, holder, paths(ways(holder))]).toEqual([
          graph,
          holder,
          oracle(pairs, scanned, holder),
        ]);
      }
    }
  });
});

describe('the cost', () => {
  /** One scanned import, `branches` helpers that meet again at two hubs, `holders` below both. */
  const reconverging = (branches: number, holders: number) => {
    const branch = Array.from({ length: branches }, (_, index) => `b${String(index)}`);
    const holder = Array.from({ length: holders }, (_, index) => `h${String(index)}`);
    const hubs = ['hub1', 'hub2'];
    const pairs = [
      ['page', 'kit'] as const,
      ...branch.map((name) => ['kit', name] as const),
      ...branch.flatMap((name) => hubs.map((hub) => [name, hub] as const)),
      ...hubs.flatMap((hub) => holder.map((name) => [hub, name] as const)),
    ];
    const graph = graphOf(pairs);
    const ways = scanWays(holder, new Set(['page']), graph.edges);
    const found = holder.map((name) => paths(ways(name)));
    return { found, edges: pairs.length, reads: graph.reads() };
  };

  test.each([
    [100, 1],
    [100, 200],
    [1_000, 200],
  ])(
    '%d branches and %d holders: a few reads an edge, plus the chains told',
    (branches, holders) => {
      const { found, edges, reads } = reconverging(branches, holders);
      expect(new Set(found.flat()).size).toBe(holders);
      expect(found[0]).toEqual(['page kit b0 hub1 h0']);
      // Five steps a chain. A search per holder reads every branch again for each: 200 × 2,000.
      expect(reads).toBeLessThanOrEqual(8 * edges + 5 * holders);
    },
  );

  test('many scanned imports of one shared graph read it once too', () => {
    const pages = Array.from({ length: 300 }, (_, index) => `p${String(index)}`);
    const chain = Array.from({ length: 300 }, (_, index) => `c${String(index)}`);
    const pairs = [
      ...pages.map((page) => [page, 'c0'] as const),
      ...chain.slice(1).map((name, index) => [`c${String(index)}`, name] as const),
      ['c0', 'end'] as const,
    ];
    const graph = graphOf(pairs);
    const ways = scanWays(['end'], new Set(pages), graph.edges)('end');
    expect(ways.length).toBe(300);
    expect(graph.reads()).toBeLessThanOrEqual(8 * pairs.length + 5 * 300);
  });
});
