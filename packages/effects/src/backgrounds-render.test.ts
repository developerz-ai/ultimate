// The server frame of every background, through the inert renderer a `site/` page uses: the tier
// label, one decorative layer hidden from assistive tech (the canvas inside it), content outside
// it, and colour carried only as role references — never a literal.

import { describe, expect, test } from 'bun:test';
import { byTag, type RenderNode, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { Aurora } from './aurora/Aurora';
import { EffectCanvas } from './effect-canvas/EffectCanvas';
import { GradientOrbs } from './gradient-orbs/GradientOrbs';
import { GridGlow } from './grid-glow/GridGlow';
import { MosaicGrid } from './mosaic-grid/MosaicGrid';
import { mosaicCell } from './mosaic-grid/mosaic-grid-view';
import { Noise } from './noise/Noise';
import { ShaderBackground } from './shader-background/ShaderBackground';

const CASES: readonly (readonly [string, unknown, Record<string, unknown>, string, boolean])[] = [
  ['Aurora', Aurora, {}, 'css', false],
  ['GradientOrbs', GradientOrbs, {}, 'css', false],
  ['GridGlow', GridGlow, {}, 'css', false],
  ['Noise', Noise, {}, 'static', false],
  ['MosaicGrid', MosaicGrid, {}, 'static', true],
  ['ShaderBackground', ShaderBackground, {}, 'static', true],
  ['EffectCanvas', EffectCanvas, { fallback: 'still', draw: () => () => {} }, 'static', true],
];

/** `#abc`, `rgb(1 …`, `hsl(…`, `oklch(…`: a colour written out instead of read from a role. */
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(\s*\d|hsla?\(|oklch\(|\b(?:red|white|black)\b/i;

const styleValues = (nodes: readonly RenderNode[]): string[] =>
  nodes.flatMap((node) => {
    const style = node.props['style'];
    return style !== null && typeof style === 'object' ? Object.values(style).map(String) : [];
  });

const text = (nodes: readonly RenderNode[]): string =>
  nodes
    .flatMap((node) => [node.props['children']].flat())
    .filter((c) => typeof c === 'string')
    .join('|');

describe('render · backgrounds, server frame', () => {
  for (const [name, component, props, label, canvas] of CASES) {
    test(`${name}: labelled ${label}, one hidden layer, role colours only`, () => {
      const nodes = renderNodes(component, { ...props, children: 'hero copy' });
      const roots = withAttr(nodes, 'data-effect-backend');
      expect(roots.map((node) => node.props['data-effect-backend'])).toContain(label);
      const layers = withAttr(nodes, 'aria-hidden', 'true');
      expect(layers.length).toBeGreaterThanOrEqual(1);
      expect(byTag(nodes, 'canvas')).toHaveLength(canvas ? 1 : 0);
      const literals = styleValues(nodes).filter((value) => COLOUR_LITERAL.test(value));
      expect(literals).toEqual([]);
      expect(text(nodes)).toContain('hero copy');
    });
  }

  test('a canvas lives inside the hidden layer, never beside the content', () => {
    const nodes = renderNodes(MosaicGrid, {});
    const layer = withAttr(nodes, 'aria-hidden', 'true')[0];
    const inLayer = renderNodes(() => layer, {});
    expect(byTag(inLayer, 'canvas')).toHaveLength(1);
  });

  test('MosaicGrid paints frame 0 as real tiles, the values the canvas starts from', () => {
    const nodes = renderNodes(MosaicGrid, { cols: 4, rows: 3 });
    const tiles = nodes.filter((node) => {
      const style = node.props['style'];
      return style !== null && typeof style === 'object' && '--fx-a' in style;
    });
    expect(tiles).toHaveLength(12);
    const cell = mosaicCell(2, 1, 0);
    expect(tiles[6]?.props['style']).toEqual({
      '--fx-a': String(cell.alpha),
      '--fx-m': String(cell.mix),
    });
  });

  test('grain lays the SVG grain over its frame; mesh and dots do not', () => {
    const grain = renderNodes(ShaderBackground, { preset: 'grain' });
    const mesh = renderNodes(ShaderBackground, { preset: 'mesh' });
    expect(byTag(grain, 'feTurbulence')).toHaveLength(1);
    expect(byTag(mesh, 'feTurbulence')).toHaveLength(0);
  });

  test('Noise holds no animation: one fixed turbulence, tinted with currentColor', () => {
    const nodes = renderNodes(Noise, {});
    const turbulence = byTag(nodes, 'feTurbulence')[0];
    expect(turbulence?.props['seed']).toBe('7');
    expect(byTag(nodes, 'feFlood')[0]?.props['flood-color']).toBe('currentColor');
    expect(byTag(nodes, 'animate')).toHaveLength(0);
  });
});
