// The wiring of the two chart components — what the markup carries — asked of the components;
// the geometry has its own tests in `bar-chart-view.test.ts` and `sparkline-view.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { BarChart } from './BarChart';
import { Sparkline } from './Sparkline';

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
    const texts = byTag(renderNodes(BarChart, { label: 'x', points }), 'text');
    expect(texts.map((t) => t.props['children'])).toEqual([9, '2026-09-17', '2026-09-19']);
  });

  test('no points draws no bars and no date labels', () => {
    const nodes = renderNodes(BarChart, { label: 'x', points: [] });
    expect(withAttr(nodes, 'data-bar')).toHaveLength(0);
    expect(byTag(nodes, 'text')).toHaveLength(1);
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
