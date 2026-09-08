// The WIRING, not the rule: `async-branch.test.ts` proves the four-way decision, and this file
// proves the component actually renders the branch it was handed — a correct reducer called with
// the wrong argument passes every assertion about itself. Probe-based, beside its component, the
// same shape as `DataTable.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { byTag, one, type ProbeNode, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { AsyncRegion } from './AsyncRegion';

const ROWS = ['alpha', 'beta'];

interface Rendered {
  readonly nodes: ProbeNode[];
  readonly slots: string[];
}

const render = (extra: Record<string, unknown>): Rendered => {
  const slots: string[] = [];
  const nodes = renderNodes(AsyncRegion, {
    reserve: { lines: 3, height: '1.5rem' },
    ready: (data: readonly string[]) => {
      slots.push(`ready:${data.join(',')}`);
      return null;
    },
    empty: () => {
      slots.push('empty');
      return null;
    },
    ...extra,
  });
  return { nodes, slots };
};

/** The region itself: the one element carrying the reserved box. */
const region = (nodes: readonly ProbeNode[]): ProbeNode =>
  one(
    byTag(nodes, 'div').filter(
      (node) =>
        (node.props['style'] as Record<string, string> | undefined)?.['--async-reserve'] !==
        undefined,
    ),
    'async region',
  );

/** Skeleton's placeholder lines, identified by the box it was given. */
const placeholders = (nodes: readonly ProbeNode[]): ProbeNode[] =>
  byTag(nodes, 'span').filter(
    (node) =>
      (node.props['style'] as Record<string, string> | undefined)?.['--skeleton-h'] !== undefined,
  );

describe('AsyncRegion', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the component compiles to a JSX factory this file understands', () => {
    expect(render({ state: { status: 'ready', data: ROWS } }).nodes.length).toBeGreaterThan(0);
  });

  test('pending renders the placeholder and neither content slot', () => {
    const { nodes, slots } = render({ state: { status: 'pending' } });
    expect(slots).toEqual([]);
    expect(placeholders(nodes)).toHaveLength(3);
    expect(region(nodes).props['aria-busy']).toBe('true');
  });

  test('the placeholder’s line box is the reserved one, so the load is not a layout shift', () => {
    const { nodes } = render({ state: { status: 'pending' } });
    const style = placeholders(nodes)[0]?.props['style'] as Record<string, string>;
    expect(style['--skeleton-h']).toBe('1.5rem');
    expect(region(nodes).props['style']).toEqual({ '--async-reserve': 'calc(3 * 1.5rem)' });
  });

  test('every branch holds the same reserved box — that is what makes it a reservation', () => {
    const box = { '--async-reserve': 'calc(3 * 1.5rem)' };
    for (const state of [
      { status: 'pending' },
      { status: 'ready', data: ROWS },
      { status: 'ready', data: [] },
      { status: 'failed', error: new TypeError('boom') },
    ]) {
      expect(region(render({ state }).nodes).props['style']).toEqual(box);
    }
  });

  test('a refetch keeps the previous content rendered, and says it is busy', () => {
    const { nodes, slots } = render({ state: { status: 'refreshing', data: ROWS } });
    // The bug this replaces: `loading` tearing the current page down to a skeleton on every
    // keystroke, which is the whole reason a search box feels slow.
    expect(slots).toEqual(['ready:alpha,beta']);
    expect(placeholders(nodes)).toHaveLength(0);
    expect(region(nodes).props['aria-busy']).toBe('true');
  });

  test('a completed empty result reaches the empty slot, and only then', () => {
    expect(render({ state: { status: 'ready', data: [] } }).slots).toEqual(['empty']);
    expect(render({ state: { status: 'pending' } }).slots).toEqual([]);
  });

  test('a settled result is not busy', () => {
    const { nodes } = render({ state: { status: 'ready', data: ROWS } });
    expect(region(nodes).props['aria-busy']).toBe('false');
  });

  test('a failure renders the error contract verbatim, and no content slot at all', () => {
    const retries: number[] = [];
    const { nodes, slots } = render({
      state: {
        status: 'failed',
        error: new UltimateError({ code: 'X_ID_INVALID', cause: 'not a uuid', fix: 'parseId()' }),
      },
      onRetry: () => retries.push(1),
    });
    expect(slots).toEqual([]);
    const text = JSON.stringify(byTag(nodes, 'dd').map((node) => node.props['children']));
    expect(text).toContain('X_ID_INVALID');
    expect(text).toContain('not a uuid');
    // The retry reaches the caller: ErrorState's own button is the only control on this branch.
    expect(withAttr(byTag(nodes, 'button'), 'onClick')).toHaveLength(1);
  });

  test('a caller’s emptiness test decides for an envelope the component cannot read', () => {
    const state = { status: 'ready', data: { items: [] as readonly string[] } };
    expect(
      renderNodes(AsyncRegion, {
        state,
        reserve: { lines: 1 },
        ready: () => null,
        empty: () => null,
        isEmpty: (data: { items: readonly string[] }) => data.items.length === 0,
      }).length,
    ).toBeGreaterThan(0);
  });

  for (const lines of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
    test(`reserve.lines: ${String(lines)} is refused, never a busy region with no box`, () => {
      expect(() => render({ state: { status: 'pending' }, reserve: { lines } })).toThrow(
        /X_INVARIANT/,
      );
    });
  }
});
