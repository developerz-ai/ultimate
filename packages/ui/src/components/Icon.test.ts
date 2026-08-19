// `iconElements` is the gate; `glyphNode` is the sink behind it, and the two are different bugs.
// The gate says which attributes a tag MAY carry; the switch decides which ones actually reach the
// element — a `rect` that forgot `ry`, or a `line` that read `x1` twice, renders a plausible wrong
// icon that no allowlist test can see.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { iconChevronDown } from '../icons/glyphs/chevron-down';
import { byTag, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Icon } from './Icon';
import type { IconGlyph } from './icon-glyph';

/** One element per tag the table declares, each carrying every attribute it allows. */
const EVERY_SHAPE: IconGlyph = [
  ['circle', { cx: '11', cy: '12', r: '8', fill: 'none' }],
  ['ellipse', { cx: '1', cy: '2', rx: '3', ry: '4' }],
  ['line', { x1: '5', x2: '6', y1: '7', y2: '8' }],
  ['path', { d: 'm6 9 6 6 6-6' }],
  ['polygon', { points: '1,2 3,4' }],
  ['polyline', { points: '5,6 7,8' }],
  ['rect', { x: '3', y: '4', width: '18', height: '19', rx: '2', ry: '1' }],
];

describe('Icon', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the component compiles to a JSX factory this file understands', () => {
    expect(renderNodes(Icon, { glyph: iconChevronDown }).length).toBeGreaterThan(0);
  });

  test('is decorative by default — hidden, with no role and no name', () => {
    const svg = one(byTag(renderNodes(Icon, { glyph: iconChevronDown }), 'svg'), 'icon');
    expect(svg.props['aria-hidden']).toBe('true');
    expect(svg.props['role']).toBeUndefined();
    expect(svg.props['aria-label']).toBeUndefined();
  });

  test('a label promotes it to a named image, and drops the hiding', () => {
    const svg = one(
      byTag(renderNodes(Icon, { glyph: iconChevronDown, label: 'Expand' }), 'svg'),
      'icon',
    );
    expect(svg.props['role']).toBe('img');
    expect(svg.props['aria-label']).toBe('Expand');
    // Hidden AND named is a contradiction: the name never reaches the accessibility tree.
    expect(svg.props['aria-hidden']).toBeUndefined();
  });

  test('every glyph is drawn on the 24×24 grid, sized in CSS and never here', () => {
    const svg = one(byTag(renderNodes(Icon, { glyph: iconChevronDown }), 'svg'), 'icon');
    expect(svg.props['viewBox']).toBe('0 0 24 24');
    expect(svg.props['width']).toBeUndefined();
    expect(svg.props['height']).toBeUndefined();
  });

  test('each shape reaches the element with the attributes its tag declares', () => {
    const nodes = renderNodes(Icon, { glyph: EVERY_SHAPE });
    const shapes = nodes.filter((node) => node.type !== 'svg');

    expect(shapes.map((node) => node.type)).toEqual([
      'circle',
      'ellipse',
      'line',
      'path',
      'polygon',
      'polyline',
      'rect',
    ]);
    expect(shapes.map((node) => node.props)).toEqual([
      { cx: '11', cy: '12', r: '8', fill: 'none' },
      { cx: '1', cy: '2', rx: '3', ry: '4' },
      { x1: '5', x2: '6', y1: '7', y2: '8' },
      { d: 'm6 9 6 6 6-6' },
      { points: '1,2 3,4' },
      { points: '5,6 7,8' },
      { x: '3', y: '4', width: '18', height: '19', rx: '2', ry: '1' },
    ]);
  });

  test('the polygon and the polyline are two different elements, not one aliased', () => {
    const nodes = renderNodes(Icon, {
      glyph: [
        ['polygon', { points: '1,2' }],
        ['polyline', { points: '3,4' }],
      ] satisfies IconGlyph,
    });
    expect(byTag(nodes, 'polygon')).toHaveLength(1);
    expect(byTag(nodes, 'polyline')).toHaveLength(1);
  });

  test('a glyph the gate refuses never reaches the element', () => {
    expect(() =>
      renderNodes(Icon, { glyph: [['script', { d: 'x' }]] as unknown as IconGlyph }),
    ).toThrow(expect.objectContaining({ code: UI_ERROR_CODES.invalidValue }));
  });

  test('an empty glyph renders the svg and no shape inside it', () => {
    const nodes = renderNodes(Icon, { glyph: [] satisfies IconGlyph });
    expect(nodes).toHaveLength(1);
    expect(withAttr(nodes, 'viewBox', '0 0 24 24')).toHaveLength(1);
  });
});
