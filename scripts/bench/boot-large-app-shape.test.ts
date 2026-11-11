// The large-app bench's pure half: names that sort as made, what counts as a source file, the
// manifest's counts, the median it reports and the verdict beside it.

import { describe, expect, test } from 'bun:test';
import {
  countsAsSource,
  manifestCounts,
  resourceName,
  summarise,
  verdict,
} from './boot-large-app-shape';

describe('boot-large-app shape', () => {
  test('resource names sort in the order they were generated', () => {
    expect([resourceName(10), resourceName(9), resourceName(100)].sort()).toEqual([
      'bench-r009',
      'bench-r010',
      'bench-r100',
    ]);
  });

  test('a source is TypeScript outside any node_modules', () => {
    expect(countsAsSource('apps/web/app/posts/page.tsx')).toBe(true);
    expect(countsAsSource('apps/web/app/posts/repo.ts')).toBe(true);
    expect(countsAsSource('apps/web/app/posts/ui.module.scss')).toBe(false);
    expect(countsAsSource('apps/web/node_modules/solid-js/index.ts')).toBe(false);
  });

  test('the manifest lists are counted, an absent one as 0', () => {
    expect(manifestCounts({ entities: [1, 2], actions: [1], routes: [] })).toEqual({
      entities: 2,
      actions: 1,
      queries: 0,
      jobs: 0,
      routes: 0,
    });
    expect(manifestCounts(undefined).entities).toBe(0);
  });

  test('the summary is the median of each figure, every run kept', () => {
    const runs = [
      { toFirst200Ms: 300, peakRssMb: 10 },
      { toFirst200Ms: 100, peakRssMb: 30 },
      { toFirst200Ms: 200, peakRssMb: 20 },
    ];
    expect(summarise(runs)).toEqual({ medianMs: 200, medianPeakRssMb: 20, runs });
  });

  test('a target is met strictly below it', () => {
    expect(verdict(9_999, 10_000)).toBe('met');
    expect(verdict(10_000, 10_000)).toBe('missed');
  });
});
