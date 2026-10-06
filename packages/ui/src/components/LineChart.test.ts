// The wiring of LineChart and AreaChart — what the markup carries — asked of the components; the
// geometry has its own tests in `line-chart-view.test.ts` and `chart-ticks-view.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ProbeNode } from '../jsx-probe';
import { byTag, nodesOf, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { AreaChart, LineChart } from './LineChart';

const keys = ['mon', 'tue', 'wed'];
const series = [
  { label: 'Web', values: [3, 9, 4] },
  { label: 'App', values: [1, null, 6] },
];
const base = { label: 'Signups, this week', keys, series, keyLabel: 'Day' };

const text = (node: ProbeNode | undefined): string =>
  [node?.props['children']]
    .flat()
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .join('');

beforeAll(probe);
afterAll(unprobe);

describe('LineChart', () => {
  test('a figure named by its caption, holding one svg image with the same name', () => {
    const nodes = renderNodes(LineChart, base);
    expect(nodes[0]?.type).toBe('figure');
    expect(text(one(byTag(nodes, 'figcaption'), 'caption'))).toBe('Signups, this week');
    const svg = one(withAttr(byTag(nodes, 'svg'), 'role', 'img'), 'plot');
    expect(svg.props['aria-label']).toBe('Signups, this week');
  });

  test('one line per series, each in its own colour slot with its own dash', () => {
    const nodes = renderNodes(LineChart, base);
    const groups = withAttr(nodes, 'data-line');
    expect(groups.map((g) => g.props['data-series'])).toEqual([1, 2]);
    const dashes = groups.map(
      (g) =>
        withAttr(nodesOf(g.props['children']), 'stroke-dasharray')[0]?.props['stroke-dasharray'],
    );
    expect(dashes[0]).toBeUndefined();
    expect(dashes[1]).toBeDefined();
    // Markers are shapes, and the two series' shapes differ — readable in greyscale.
    const shapes = groups.map(
      (g) => withAttr(nodesOf(g.props['children']), 'data-marker')[0]?.props['data-marker'],
    );
    expect(new Set(shapes).size).toBe(2);
  });

  test('a line chart fills nothing; an area chart fills under every series', () => {
    const area = (nodes: ProbeNode[]) => withAttr(nodes, 'data-area', 'true');
    expect(area(renderNodes(LineChart, base))).toHaveLength(0);
    // Web is one unbroken run; App's two points are split by a gap, and a lone point has no area.
    expect(area(renderNodes(AreaChart, base))).toHaveLength(1);
    const unbroken = { ...base, series: [series[0], { label: 'App', values: [1, 2, 6] }] };
    expect(area(renderNodes(AreaChart, unbroken))).toHaveLength(2);
  });

  test('the legend names every series beside a swatch drawn with that series’ slot', () => {
    const nodes = renderNodes(LineChart, base);
    const items = byTag(nodes, 'li');
    expect(items).toHaveLength(2);
    const names = items.map((li) =>
      text(withAttr(nodesOf(li.props['children']), 'data-legend', 'name')[0]),
    );
    expect(names).toEqual(['Web', 'App']);
    const swatches = items.map(
      (li) => byTag(nodesOf(li.props['children']), 'svg')[0]?.props['data-series'],
    );
    expect(swatches).toEqual([1, 2]);
  });

  test('one series needs no legend: the caption already names it', () => {
    const nodes = renderNodes(LineChart, { ...base, series: [series[0]] });
    expect(byTag(nodes, 'ul')).toHaveLength(0);
  });

  test('the fallback table holds the same numbers the plot draws, with a gap left empty', () => {
    const nodes = renderNodes(LineChart, base);
    const table = one(byTag(nodes, 'table'), 'fallback');
    const inTable = nodesOf(table.props['children']);
    expect(text(one(byTag(inTable, 'caption'), 'caption'))).toBe('Signups, this week');
    expect(byTag(inTable, 'th').map(text)).toEqual(['Day', 'Web', 'App', 'mon', 'tue', 'wed']);
    expect(byTag(inTable, 'td').map(text)).toEqual(['3', '1', '9', '', '4', '6']);
    // Row heads are scoped to their row, column heads to their column.
    const scopes = byTag(inTable, 'th').map((th) => th.props['scope']);
    expect(scopes).toEqual(['col', 'col', 'col', 'row', 'row', 'row']);
  });

  test('values go through the caller’s format, in the plot labels and the table alike', () => {
    const nodes = renderNodes(LineChart, { ...base, format: (v: number) => `${v} u` });
    const cells = byTag(nodesOf(one(byTag(nodes, 'table'), 't').props['children']), 'td');
    expect(text(cells[0])).toBe('3 u');
    expect(withAttr(nodes, 'data-tick', 'value').map(text)).toContain('10 u');
  });

  test('axis labels are HTML beside the svg, never svg text, and hidden from the a11y tree', () => {
    const nodes = renderNodes(LineChart, base);
    expect(byTag(nodes, 'text')).toHaveLength(0);
    const svg = one(withAttr(byTag(nodes, 'svg'), 'role', 'img'), 'plot');
    expect(withAttr(nodesOf(svg.props['children']), 'data-tick')).toHaveLength(0);
    const hidden = withAttr(nodes, 'aria-hidden', 'true').filter((n) => n.type === 'div');
    expect(hidden).toHaveLength(2);
  });

  test('the value axis reads its nice ticks, one grid line each', () => {
    const nodes = renderNodes(LineChart, base);
    expect(withAttr(nodes, 'data-tick', 'value').map(text)).toEqual([
      '0',
      '2',
      '4',
      '6',
      '8',
      '10',
    ]);
    expect(byTag(nodes, 'line')).toHaveLength(6);
  });
});

describe('LineChart over small counts', () => {
  test('whole ticks, and the top tick — the max — is labelled at every width', () => {
    const nodes = renderNodes(LineChart, {
      label: 'Signups',
      keys: ['a', 'b', 'c'],
      series: [{ label: 's', values: [0, 1, 2] }],
    });
    const ticks = withAttr(nodes, 'data-tick', 'value');
    expect(ticks.map(text)).toEqual(['0', '1', '2']);
    expect(ticks.at(-1)?.props['data-minor']).toBe('false');
  });
});

describe('LineChart at 390px — the attributes the container query reads', () => {
  const many = Array.from({ length: 30 }, (_, i) => `d${i + 1}`);
  const nodes = () =>
    renderNodes(LineChart, {
      label: 'x',
      keys: many,
      series: [{ label: 's', values: many.map((_, i) => i) }],
    });

  test('at most three key labels are flagged for a narrow container, six for a wide one', () => {
    const labels = withAttr(nodes(), 'data-tick', 'key');
    expect(withAttr(labels, 'data-narrow', 'true').length).toBeLessThanOrEqual(3);
    expect(withAttr(labels, 'data-wide', 'true').length).toBeLessThanOrEqual(6);
    expect(withAttr(labels, 'data-narrow', 'true').map(text).at(-1)).toBe('d30');
  });

  test('every other value label is minor, and is the one a narrow chart drops', () => {
    const ticks = withAttr(nodes(), 'data-tick', 'value');
    expect(ticks.map((t) => t.props['data-minor'])).toEqual(
      ticks.map((_, i) =>
        ticks.length > 3 && (ticks.length - 1 - i) % 2 === 1 ? 'true' : 'false',
      ),
    );
  });

  test('labels are positioned by a custom property, never by an inline length', () => {
    for (const label of withAttr(nodes(), 'data-tick')) {
      expect(Object.keys(label.props['style'] as object)).toEqual(['--at']);
    }
  });
});

describe('LineChart keyboard layer', () => {
  test('off by default: not one tab stop', () => {
    expect(withAttr(renderNodes(LineChart, base), 'tabindex')).toHaveLength(0);
  });

  test('focusable: one tab stop per drawn point, series by series, oldest first', () => {
    const hits = withAttr(renderNodes(LineChart, { ...base, focusable: true }), 'tabindex', 0);
    // App's tuesday is a gap: nothing drawn, nothing to focus.
    expect(hits.map((h) => h.props['aria-label'])).toEqual([
      'mon, Web: 3',
      'tue, Web: 9',
      'wed, Web: 4',
      'mon, App: 1',
      'wed, App: 6',
    ]);
    for (const hit of hits) {
      expect(hit.props['role']).toBe('img');
      // The visible readout is the accessible name, verbatim — and hidden from the tree itself.
      const readout = one(
        withAttr(nodesOf(hit.props['children']), 'aria-hidden', 'true'),
        'readout',
      );
      const bubble = one(withAttr(nodesOf(readout.props['children']), 'data-readout'), 'bubble');
      expect(text(bubble)).toBe(hit.props['aria-label'] as string);
    }
  });

  test('a focusable chart still renders its points outside the svg image', () => {
    const nodes = renderNodes(LineChart, { ...base, focusable: true });
    const svg = one(withAttr(byTag(nodes, 'svg'), 'role', 'img'), 'plot');
    expect(withAttr(nodesOf(svg.props['children']), 'tabindex')).toHaveLength(0);
  });
});
