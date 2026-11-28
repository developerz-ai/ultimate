import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  ALIAS_CONTRAST_PAIRS,
  COLOR_ALIASES,
  CONTRAST_PAIRS,
  colorTokens,
  contrastRatio,
  defineTheme,
} from '@ultimat3/ui';
import type { Extraction, ObservedColor, ObservedMotion } from './design-extract';
import {
  clusterPalette,
  mapDesign,
  motionMap,
  proposeMotion,
  proposeRadius,
  RADIUS_RUNGS,
  type ThemeTables,
} from './design-map';

const tables: ThemeTables = {
  colors: colorTokens,
  aliases: COLOR_ALIASES,
  pairs: [...CONTRAST_PAIRS, ...ALIAS_CONTRAST_PAIRS],
  contrast: contrastRatio,
};

const color = (
  rgb: readonly [number, number, number],
  use: ObservedColor['use'],
  weight: number,
): ObservedColor => ({ rgb, alpha: 1, use, weight });

const motion = (overrides: Partial<ObservedMotion>): ObservedMotion => ({
  kind: 'animation',
  trigger: 'enter',
  durationMs: 220,
  delayMs: 0,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  iterations: 1,
  properties: ['opacity'],
  count: 1,
  ...overrides,
});

const extraction = (overrides: Partial<Extraction>): Extraction => ({
  colors: [],
  fonts: [],
  spacing: [],
  radii: [],
  shadows: [],
  backdrop: { count: 0, blurPx: [] },
  canvases: 0,
  motion: [],
  links: [],
  ...overrides,
});

/** A light reference: a warm white page, near-black text, one strong blue accent. */
const LIGHT = extraction({
  colors: [
    color([250, 250, 249], 'background', 900_000),
    color([252, 251, 250], 'background', 20_000),
    color([24, 24, 27], 'text', 4_000),
    color([37, 99, 235], 'background', 30_000),
    color([37, 99, 235], 'text', 300),
    color([228, 228, 231], 'border', 40),
  ],
  radii: [
    { px: 6, count: 20 },
    { px: 7, count: 2 },
    { px: 14, count: 5 },
  ],
  motion: [
    motion({ durationMs: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', count: 3 }),
    motion({ durationMs: 150, easing: 'ease-in-out', trigger: 'hover', kind: 'transition' }),
  ],
});

describe('the radius rungs', () => {
  test("agree with @ultimat3/ui's canonical _radius.scss", async () => {
    const scss = await Bun.file(join(import.meta.dir, '../../ui/src/tokens/_radius.scss')).text();
    for (const [name, px] of Object.entries(RADIUS_RUNGS)) {
      expect(scss).toContain(`${name}: ${String(px / 16)}rem,`);
    }
  });
});

describe('clusterPalette', () => {
  test('folds near colours into the heaviest and ranks by share across uses', () => {
    const palette = clusterPalette(LIGHT.colors);
    expect(palette[0]?.channels).toBe('250 250 249');
    expect(palette[0]?.uses.background).toBeGreaterThan(0.9);
    expect(palette.some((cluster) => cluster.channels === '252 251 250')).toBe(false);
  });
});

describe('proposeRadius / proposeMotion', () => {
  test('a radius snaps to its nearest rung, the most-used value per rung wins', () => {
    expect(proposeRadius(LIGHT.radii)).toEqual({ sm: '6px', md: '7px', lg: '14px' });
  });

  test('a duration snaps to its rung by the motion scale; an easing too, its curve kept', () => {
    const proposed = proposeMotion(LIGHT.motion);
    expect(proposed.duration).toEqual({ base: '300ms', fast: '150ms' });
    expect(proposed.easing?.out).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
    expect(proposed.easing?.['in-out']).toBe('cubic-bezier(0.42, 0, 0.58, 1)');
  });

  test('a curve point that is not a plain decimal is never proposed: 1e+23 is a refusal, not a tempo', () => {
    const proposed = proposeMotion([
      motion({ easing: 'cubic-bezier(0.5, 1.23e+23, 0.5, 1)' }),
      motion({ easing: 'cubic-bezier(0.5, 123456789012, 0.5, 1)' }),
    ]);
    expect(proposed.easing).toBeUndefined();
    expect(() => defineTheme({ motion: proposed })).not.toThrow();
  });

  test('a loop and a zero duration never set the tempo', () => {
    expect(
      proposeMotion([motion({ trigger: 'loop', durationMs: 9000 }), motion({ durationMs: 0 })])
        .duration,
    ).toBeUndefined();
  });
});

describe('mapDesign', () => {
  test('roles from the light capture, and the proposal is one defineTheme accepts', () => {
    const mapped = mapDesign({ light: LIGHT, dark: LIGHT }, tables);
    const light = mapped.proposal.colors?.light ?? {};
    expect(light['bg']).toBe('250 250 249');
    expect(light['fg']).toBe('24 24 27');
    expect(light['accent']).toBe('37 99 235');
    // The light page photographed in dark mode is not a dark palette: nothing is proposed for it.
    expect(mapped.proposal.colors?.dark).toBeUndefined();
    expect(() => defineTheme(mapped.proposal)).not.toThrow();
  });

  test('a palette that would fail contrast is repaired by dropping the role, never shipped failing', () => {
    const unreadable = extraction({
      colors: [
        color([255, 255, 255], 'background', 1000),
        color([200, 200, 200], 'text', 1000),
        color([255, 230, 0], 'background', 400),
      ],
    });
    const mapped = mapDesign({ light: unreadable, dark: extraction({}) }, tables);
    expect(() => defineTheme(mapped.proposal)).not.toThrow();
    expect(mapped.proposal.colors?.light?.['fg']).toBeUndefined();
  });

  test('without the theme tables, colours are left out and the rest still maps', () => {
    const mapped = mapDesign({ light: LIGHT, dark: LIGHT }, undefined);
    expect(mapped.proposal.colors).toBeUndefined();
    expect(mapped.proposal.motion?.duration?.base).toBe('300ms');
    expect(() => defineTheme(mapped.proposal)).not.toThrow();
  });

  test('every palette cluster names its nearest shipped role', () => {
    const mapped = mapDesign({ light: LIGHT, dark: LIGHT }, tables);
    const [page] = mapped.palette.light;
    expect(Object.keys(colorTokens.light)).toContain(page?.nearest?.role ?? '');
    expect(page?.nearest?.distance).toBeLessThan(40);
  });
});

describe('motionMap', () => {
  test('each observed animation names the @ultimat3/ui/motion call or effects entry it becomes', () => {
    const map = motionMap(
      extraction({
        motion: [
          motion({ trigger: 'enter' }),
          motion({ trigger: 'scroll', durationMs: 0 }),
          motion({ trigger: 'hover', kind: 'transition' }),
          motion({
            trigger: 'loop',
            durationMs: 20_000,
            properties: ['transform'],
            iterations: -1,
          }),
          motion({ easing: 'linear(0, 0.5 20%, 1.1 50%, 1)' }),
          motion({ properties: ['width', 'height'] }),
        ],
        backdrop: { count: 2, blurPx: [12] },
        canvases: 1,
      }),
    );
    expect(map.map((entry) => `${entry.module}:${entry.name}`)).toEqual([
      '@ultimat3/ui/motion:animate',
      '@ultimat3/ui/motion:scrollLinked',
      '@ultimat3/ui/motion:motionTiming',
      '@ultimat3/effects:Marquee',
      '@ultimat3/ui/motion:springLinear',
      '@ultimat3/ui/motion:layout',
      '@ultimat3/effects:GlassSurface',
      '@ultimat3/effects:EffectCanvas',
    ]);
    expect(map[0]).toMatchObject({ duration: 'base', easing: 'out' });
  });
});
