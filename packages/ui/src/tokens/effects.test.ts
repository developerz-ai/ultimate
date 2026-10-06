// The dashboard helpers, COMPILED: what `glow-edge`, `grid-texture` and `touch-target` emit, and
// that `theme.scss` declares every custom property they and the new token slots read. A helper
// that reads a property nothing declares is an invisible effect, not a failing build — so this is.

import { describe, expect, test } from 'bun:test';
import { compileScss, compileScssFile } from '../sass-probe-fixture';
import { CHART_ROLES, SHADOW_NAMES } from './tokens';

const TOKENS = Bun.fileURLToPath(new URL('.', import.meta.url));
const AT = `${TOKENS}__compiled.scss`;

const css = async (body: string): Promise<string> =>
  (await compileScss(`@use './index' as t;\n${body}`, AT)).replace(/\s+/g, ' ').trim();

describe('theme.scss declares the new slots', () => {
  test('every chart role, shadow rung, the data font and the touch target', async () => {
    const theme = await compileScssFile(`${TOKENS}theme.scss`);
    const missing = [
      ...CHART_ROLES.map((role) => `--color-${role}:`),
      ...SHADOW_NAMES.map((name) => `--shadow-${name}:`),
      '--font-data:',
      '--touch-target:',
    ].filter((declaration) => !theme.includes(declaration));
    expect(missing).toEqual([]);
  });

  test('a chart role is themed — declared in the light root, the dark query and both attributes', async () => {
    const theme = await compileScssFile(`${TOKENS}theme.scss`);
    expect(theme.split('--color-chart-1:').length - 1).toBe(4);
    expect(theme.split('--shadow-glow-md:').length - 1).toBe(4);
  });
});

describe('touch-target', () => {
  test('by default the box itself is at least the target, on both logical axes', async () => {
    expect(await css('.a { @include t.touch-target; }')).toBe(
      '.a { min-block-size: var(--touch-target); min-inline-size: var(--touch-target); }',
    );
  });

  test('extended, the box keeps its size and a centred ::after grows the hit area', async () => {
    const out = await css('.a { @include t.touch-target($extend: true); }');
    expect(out).toContain('.a { position: relative; }');
    expect(out).toContain('content: ""');
    // `min(0px, …)`: a box already larger than the target is never shrunk to it.
    expect(out).toContain('inset-block: min(0px, (100% - var(--touch-target)) / 2)');
    expect(out).toContain('inset-inline: min(0px, (100% - var(--touch-target)) / 2)');
    expect(out).not.toMatch(/\b(left|right|top|bottom):/);
  });

  test('t.touch(target) reads the token, so a component can size by it directly', async () => {
    expect(await css('.a { x: t.touch(target); }')).toBe('.a { x: var(--touch-target); }');
  });
});

describe('glow-edge', () => {
  test('is a hairline accent ring plus a glow rung, as one box-shadow', async () => {
    expect(await css('.a { @include t.glow-edge; }')).toBe(
      '.a { box-shadow: inset 0 0 0 var(--stroke-hairline) rgb(var(--color-accent)/0.55), var(--shadow-glow-sm); }',
    );
    expect(await css(".a { @include t.glow-edge('glow-lg', 0.8); }")).toContain(
      'rgb(var(--color-accent)/0.8), var(--shadow-glow-lg)',
    );
  });
});

describe('grid-texture', () => {
  test('draws scanlines and a grid from roles and strokes, never a colour or a raw length', async () => {
    const out = await css('.a { @include t.grid-texture; }');
    expect(out).toContain('repeating-linear-gradient(180deg, rgb(var(--color-fg)/0.04)');
    expect(out).toContain(
      'linear-gradient(90deg, rgb(var(--color-accent)/0.08) var(--stroke-hairline)',
    );
    expect(out).toContain(
      'background-size: auto, var(--space-6) var(--space-6), var(--space-6) var(--space-6)',
    );
    expect(out).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(\d/i);
    expect(out).not.toMatch(/\d+(\.\d+)?(px|rem)(?!\))/);
    // It writes the image only: the element's own background colour must survive.
    expect(out).not.toMatch(/background(-color)?:/);
  });

  test("without scanlines it is the grid alone, and the pitch is the caller's", async () => {
    const out = await css('.a { @include t.grid-texture(t.space(4), 0.1, false); }');
    expect(out).not.toContain('repeating-linear-gradient');
    expect(out).toContain(
      'background-size: var(--space-4) var(--space-4), var(--space-4) var(--space-4)',
    );
  });

  test('is withdrawn where texture is noise: more contrast, forced colours', async () => {
    expect(await css('.a { @include t.grid-texture; }')).toContain(
      '@media (prefers-contrast: more), (forced-colors: active) { .a { background-image: none; } }',
    );
  });

  test('animates nothing — there is no motion for reduced-motion to take away', async () => {
    expect(await css('.a { @include t.grid-texture; @include t.glow-edge; }')).not.toMatch(
      /animation|transition/,
    );
  });
});
