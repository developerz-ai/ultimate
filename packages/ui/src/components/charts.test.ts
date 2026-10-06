// The wiring of the two chart components — what the markup carries — asked of the components;
// the geometry has its own tests in `bar-chart-view.test.ts` and `sparkline-view.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ProbeNode } from '../jsx-probe';
import { byTag, nodesOf, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { BarChart } from './BarChart';
import { Sparkline } from './Sparkline';

const cellText = (node: ProbeNode | undefined): string =>
  [node?.props['children']]
    .flat()
    .filter((c) => typeof c === 'string')
    .join('');
/** The data cells of the fallback table's BODY — the corner cell is not a datum. */
const bodyCells = (nodes: ProbeNode[]): string[] =>
  byTag(nodesOf(one(byTag(nodes, 'tbody'), 'tbody').props['children']), 'td').map(cellText);
const titleText = (nodes: ProbeNode[]): string[] =>
  byTag(nodes, 'title').map((t) => [t.props['children']].flat().join(''));

const points = [
  { key: '2026-09-17', value: 3 },
  { key: '2026-09-18', value: 9 },
  { key: '2026-09-19', value: 4 },
];

describe('BarChart', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('is an image with a name, one data-bar rect per point, each with a title', () => {
    const nodes = renderNodes(BarChart, { label: 'Clicks, last 3 days', points });
    const svg = one(byTag(nodes, 'svg'), 'chart');
    expect(svg.props['role']).toBe('img');
    expect(svg.props['aria-label']).toBe('Clicks, last 3 days');
    expect(withAttr(nodes, 'data-bar', 'true')).toHaveLength(3);
    expect(byTag(nodes, 'title')).toHaveLength(3);
    // Grid lines are <line>, never <rect>, so a bar count stays a tested fact.
    expect(byTag(nodes, 'line')).toHaveLength(4);
  });

  test('the axis reads the busiest value and the first and last keys', () => {
    const labels = withAttr(renderNodes(BarChart, { label: 'x', points }), 'data-axis');
    expect(labels.map((l) => [l.props['data-axis'], l.props['children']])).toEqual([
      // Formatted in the page's locale (`en` off-request): a 12,000 must not read as 12000.
      ['max', '9'],
      ['first', '2026-09-17'],
      ['last', '2026-09-19'],
    ]);
  });

  // #494: SVG <text> inside the viewBox scaled with the chart — 8px at 600 wide, a speck at 390 —
  // so it was hidden below `sm`. HTML text keeps its type step at every width.
  test('axis labels are HTML text beside the svg, never SVG text scaled by its viewBox', () => {
    const nodes = renderNodes(BarChart, { label: 'x', points });
    expect(byTag(nodes, 'text')).toHaveLength(0);
    const labels = withAttr(nodes, 'data-axis');
    expect(labels.map((l) => l.type)).toEqual(['span', 'span', 'span']);
    const svg = one(byTag(nodes, 'svg'), 'chart');
    const inSvg = withAttr(nodesOf(svg.props['children']), 'data-axis');
    expect(inSvg).toHaveLength(0);
  });

  test('the root is a figure carrying the caller class; the svg inside it is the image', () => {
    const nodes = renderNodes(BarChart, { label: 'x', points, class: 'mine' });
    const figure = one(byTag(nodes, 'figure'), 'root');
    expect(String(figure.props['class'])).toContain('mine');
    expect(nodes[0]).toBe(figure);
    expect(String(one(byTag(nodes, 'svg'), 'chart').props['class'])).not.toContain('mine');
  });

  test('a second series stacks one data-series rect per non-zero point, titled by its label', () => {
    const nodes = renderNodes(BarChart, {
      label: 'Runs',
      points: [
        { key: 'a', value: 3, secondary: 1 },
        { key: 'b', value: 2, secondary: 0 },
      ],
      seriesLabels: { primary: 'done', secondary: 'failed' },
    });
    expect(withAttr(nodes, 'data-bar', 'true')).toHaveLength(2);
    const stacked = withAttr(nodes, 'data-series', 'secondary');
    expect(stacked).toHaveLength(1);
    const titles = byTag(nodes, 'title').map((t) => [t.props['children']].flat().join(''));
    expect(titles).toContain('a: failed 1');
    expect(titles).toContain('a: done 3');
    // The busiest STACK is the axis figure, not the busiest primary value.
    expect(withAttr(nodes, 'data-axis', 'max')[0]?.props['children']).toBe('4');
  });

  test('one point names its key once — first and last are the same bar', () => {
    const nodes = renderNodes(BarChart, { label: 'x', points: [{ key: 'only', value: 2 }] });
    const keys = withAttr(nodes, 'data-axis').filter((l) => l.props['data-axis'] !== 'max');
    expect(keys.map((l) => [l.props['data-axis'], l.props['children']])).toEqual([
      ['first', 'only'],
    ]);
  });

  test('a large figure is grouped by the locale — the axis, the titles and the table agree', () => {
    const nodes = renderNodes(BarChart, { label: 'x', points: [{ key: 'a', value: 12000 }] });
    expect(withAttr(nodes, 'data-axis', 'max')[0]?.props['children']).toBe('12,000');
    expect(titleText(nodes)).toEqual(['a: 12,000']);
    expect(bodyCells(nodes)).toEqual(['12,000']);
  });

  test('the caller’s format wins everywhere a number is shown', () => {
    const nodes = renderNodes(BarChart, { label: 'x', points, format: (v: number) => `${v}ms` });
    expect(withAttr(nodes, 'data-axis', 'max')[0]?.props['children']).toBe('9ms');
    expect(bodyCells(nodes)).toEqual(['3ms', '9ms', '4ms']);
  });

  test('stands in a ChartFrame: a captioned figure and a hidden table of the same bars', () => {
    const nodes = renderNodes(BarChart, { label: 'Clicks', points, keyLabel: 'Day' });
    expect(cellText(one(byTag(nodes, 'figcaption'), 'caption'))).toBe('Clicks');
    const table = nodesOf(one(byTag(nodes, 'table'), 'fallback').props['children']);
    // One series: its column is named by the chart's own label.
    expect(byTag(table, 'th').map(cellText)).toEqual([
      'Day',
      'Clicks',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
    ]);
    expect(byTag(table, 'td').map(cellText)).toEqual(['3', '9', '4']);
  });

  test('one series has no legend — the existing look is unchanged', () => {
    expect(byTag(renderNodes(BarChart, { label: 'x', points }), 'ul')).toHaveLength(0);
  });

  test('two named series get a legend, and the table a column per series', () => {
    const nodes = renderNodes(BarChart, {
      label: 'Runs',
      points: [
        { key: 'a', value: 3, secondary: 1 },
        { key: 'b', value: 2 },
      ],
      seriesLabels: { primary: 'done', secondary: 'failed' },
    });
    const items = byTag(nodes, 'li');
    expect(
      items.map((li) =>
        cellText(withAttr(nodesOf(li.props['children']), 'data-legend', 'name')[0]),
      ),
    ).toEqual(['done', 'failed']);
    const table = nodesOf(one(byTag(nodes, 'table'), 'fallback').props['children']);
    // An unnamed key column is an empty corner <td>, never a <th> that names nothing.
    expect(byTag(table, 'th').map(cellText)).toEqual(['done', 'failed', 'a', 'b']);
    expect(byTag(table, 'td').map(cellText)).toEqual(['', '3', '1', '2', '0']);
  });

  test('focusable gives each drawn rect a tab stop, bar by bar, bottom then top', () => {
    const nodes = renderNodes(BarChart, {
      label: 'Runs',
      points: [
        { key: 'a', value: 3, secondary: 1 },
        { key: 'b', value: 2 },
      ],
      seriesLabels: { primary: 'done', secondary: 'failed' },
      focusable: true,
    });
    expect(withAttr(nodes, 'tabindex', 0).map((n) => n.props['aria-label'])).toEqual([
      'a, done: 3',
      'a, failed: 1',
      'b, done: 2',
    ]);
    expect(withAttr(renderNodes(BarChart, { label: 'x', points }), 'tabindex')).toHaveLength(0);
  });

  test('no points draws no bars and no date labels', () => {
    const nodes = renderNodes(BarChart, { label: 'x', points: [] });
    expect(withAttr(nodes, 'data-bar')).toHaveLength(0);
    expect(withAttr(nodes, 'data-axis')).toHaveLength(1);
  });
});

describe('Sparkline', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('is an image with a name, one path, and a dot on the last point with its title', () => {
    const nodes = renderNodes(Sparkline, { label: 'Trend', points });
    expect(one(byTag(nodes, 'svg'), 'spark').props['aria-label']).toBe('Trend');
    expect(one(byTag(nodes, 'path'), 'line').props['d']).toMatch(/^M4\.0,/);
    expect(byTag(nodes, 'circle')).toHaveLength(1);
    expect(byTag(nodes, 'title')).toHaveLength(1);
  });

  test('no points is an empty path and no dot', () => {
    const nodes = renderNodes(Sparkline, { label: 'Trend', points: [] });
    expect(one(byTag(nodes, 'path'), 'line').props['d']).toBe('');
    expect(byTag(nodes, 'circle')).toHaveLength(0);
  });
});
