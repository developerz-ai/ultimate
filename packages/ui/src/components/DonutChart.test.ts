// The wiring of DonutChart — what the markup carries. The arc maths has its own tests in
// `donut-chart-view.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ProbeNode } from '../jsx-probe';
import { byTag, nodesOf, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { DonutChart } from './DonutChart';

const text = (node: ProbeNode | undefined): string =>
  [node?.props['children']]
    .flat()
    .filter((c) => typeof c === 'string')
    .join('');

const segments = [
  { label: 'Mobile', value: 60 },
  { label: 'Desktop', value: 30 },
  { label: 'Tablet', value: 10 },
  { label: 'Watch', value: 0 },
];
const base = { label: 'Sessions by device', segments, keyLabel: 'Device', valueLabel: 'Sessions' };

beforeAll(probe);
afterAll(unprobe);

describe('DonutChart', () => {
  test('a named figure holding one svg image, one drawn segment per non-zero part', () => {
    const nodes = renderNodes(DonutChart, base);
    expect(nodes[0]?.type).toBe('figure');
    expect(text(one(byTag(nodes, 'figcaption'), 'caption'))).toBe('Sessions by device');
    const svg = one(withAttr(byTag(nodes, 'svg'), 'role', 'img'), 'ring');
    expect(svg.props['aria-label']).toBe('Sessions by device');
    // Watch is 0: listed in the legend and the table, never drawn as a sliver.
    expect(withAttr(nodes, 'data-segment').map((g) => g.props['data-series'])).toEqual([1, 2, 3]);
  });

  test('every drawn segment that fits one carries its series’ marker, all different', () => {
    const shapes = withAttr(renderNodes(DonutChart, base), 'data-marker').map(
      (m) => m.props['data-marker'],
    );
    expect(shapes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  test('the legend lists every part — zero included — with its value and share', () => {
    const items = byTag(renderNodes(DonutChart, base), 'li');
    const read = items.map((li) =>
      byTag(nodesOf(li.props['children']), 'span')
        .filter((s) => s.props['aria-hidden'] === undefined)
        .map(text),
    );
    expect(read).toEqual([
      ['Mobile', '60', '60%'],
      ['Desktop', '30', '30%'],
      ['Tablet', '10', '10%'],
      ['Watch', '0', '0%'],
    ]);
  });

  test('the fallback table is the same parts and values', () => {
    const table = nodesOf(
      one(byTag(renderNodes(DonutChart, base), 'table'), 't').props['children'],
    );
    expect(byTag(table, 'th').map(text)).toEqual([
      'Device',
      'Sessions',
      'Mobile',
      'Desktop',
      'Tablet',
      'Watch',
    ]);
    expect(byTag(table, 'td').map(text)).toEqual(['60', '30', '10', '0']);
  });

  test('the centre reads the total by default, or the caller’s figure and line', () => {
    const centre = (nodes: ProbeNode[]) =>
      byTag(nodes, 'p').flatMap((p) => byTag(nodesOf(p.props['children']), 'span').map(text));
    expect(centre(renderNodes(DonutChart, base))).toEqual(['100']);
    expect(
      centre(renderNodes(DonutChart, { ...base, centreValue: '1.2k', centreLabel: 'Total' })),
    ).toEqual(['1.2k', 'Total']);
  });

  test('nothing to total still draws the empty track, and no segment', () => {
    const nodes = renderNodes(DonutChart, { ...base, segments: [{ label: 'a', value: 0 }] });
    expect(withAttr(nodes, 'data-segment')).toHaveLength(0);
    const svg = one(withAttr(byTag(nodes, 'svg'), 'role', 'img'), 'ring');
    expect(byTag(nodesOf(svg.props['children']), 'path')).toHaveLength(1);
  });

  test('focusable: one tab stop per drawn segment, clockwise, each naming its value and share', () => {
    const hits = withAttr(renderNodes(DonutChart, { ...base, focusable: true }), 'tabindex', 0);
    expect(hits.map((h) => h.props['aria-label'])).toEqual([
      'Mobile: 60 (60%)',
      'Desktop: 30 (30%)',
      'Tablet: 10 (10%)',
    ]);
    expect(withAttr(renderNodes(DonutChart, base), 'tabindex')).toHaveLength(0);
  });
});
