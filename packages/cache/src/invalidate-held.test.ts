// The ISR holder is asked by TAG as well as told by path. The graph is one process's memory of the
// pages it rendered; a store that two controllers share, or that outlived a restart, holds pages
// with no edge in it — and a bust that read only the graph reported clean and left them standing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isolateGraph, registerDependent, resetGraph } from './graph';
import {
  invalidateTags,
  isolateTiers,
  receiveInvalidationBroadcast,
  registerRevalidator,
  resetTiers,
} from './invalidate';
import { isolateDeclaredTags, resetDeclaredTags, tag } from './tags';

const restoreGraph = isolateGraph();
const restoreTiers = isolateTiers();
const restoreTags = isolateDeclaredTags();

beforeEach(() => {
  resetGraph();
  resetTiers();
  resetDeclaredTags();
});

afterAll(() => {
  restoreGraph();
  restoreTiers();
  restoreTags();
});

describe('unit · the fan-out asks the ISR holder by tag', () => {
  test('what the holder finds under the tags is reported beside the graph’s own paths', async () => {
    const told: string[] = [];
    const asked: string[][] = [];
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    registerRevalidator(
      (path) => {
        told.push(path);
      },
      (tags) => {
        asked.push(tags.map((one) => one.entity));
        return ['/blog', '/es/blog'];
      },
    );

    const report = await invalidateTags([tag('post')]);

    expect(told).toEqual(['/blog']);
    expect(asked).toEqual([['post']]);
    expect(report.isr).toEqual(['/blog', '/es/blog']);
  });

  test('a peer’s broadcast asks it too — that is how a purge reaches every replica', async () => {
    let asked = 0;
    registerRevalidator(
      () => undefined,
      () => {
        asked += 1;
        return ['/blog'];
      },
    );
    const report = await receiveInvalidationBroadcast(['post:1']);
    expect(asked).toBe(1);
    expect(report.isr).toEqual(['/blog']);
  });

  test('a holder that rejects is a reported error, never a failed bust', async () => {
    registerRevalidator(
      () => undefined,
      () => Promise.reject(new Error('the store went away')),
    );
    const report = await invalidateTags([tag('post')]);
    expect(report.errors.map((entry) => entry.tier)).toEqual(['isr']);
    expect(report.isr).toEqual([]);
  });

  test('registering a revalidator without one clears the previous owner’s', async () => {
    let asked = 0;
    registerRevalidator(
      () => undefined,
      () => {
        asked += 1;
        return [];
      },
    );
    registerRevalidator(() => undefined);
    await invalidateTags([tag('post')]);
    expect(asked).toBe(0);
  });
});
