// A number with a bar drawn to its share of a maximum, for a table cell. The number is the fact
// and is what a screen reader reads; the bar is decoration, so it must never be announced as a
// second, unlabelled value — and it must be drawn from the same share rule `Meter` uses.

import '../theme/ambient';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { InlineBar } from './InlineBar';

describe('InlineBar', () => {
  beforeAll(probe);
  afterAll(unprobe);

  const bar = (props: Record<string, unknown>) =>
    renderNodes(InlineBar, { value: 30, max: 120, text: '30', ...props });

  test('the component compiles to a JSX factory this file understands', () => {
    expect(bar({}).length).toBeGreaterThan(0);
  });

  test('shows the caller’s formatted text — the figure is never re-formatted here', () => {
    const nodes = bar({ text: '1.234,5' });
    expect(one(withAttr(nodes, 'data-inline-bar-value'), 'value').props['children']).toBe(
      '1.234,5',
    );
  });

  test('the bar is drawn to value / max, and hidden from the accessibility tree', () => {
    const svg = one(byTag(bar({}), 'svg'), '<svg>');
    expect(svg.props['aria-hidden']).toBe('true');
    expect(svg.props['role']).toBeUndefined();
    const widths = byTag(bar({}), 'rect').map((node) => node.props['width']);
    // The track is the whole, the fill is a quarter of it.
    expect(widths).toEqual([100, '25.0']);
  });

  test('a value past either end is clamped, never a bar wider than its track', () => {
    const fill = (value: number, max: number): unknown =>
      byTag(bar({ value, max }), 'rect')[1]?.props['width'];
    expect(fill(500, 100)).toBe('100.0');
    expect(fill(-5, 100)).toBe('0.0');
    expect(fill(5, 0)).toBe('0.0');
    expect(fill(Number.NaN, 100)).toBe('0.0');
  });

  test('the text and the bar sit in one inline wrapper a cell can align', () => {
    const [root] = bar({ class: 'mine' });
    expect(root?.type).toBe('span');
    expect(String(root?.props['class'])).toContain('mine');
  });
});
