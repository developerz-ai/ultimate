// The background stylesheets, COMPILED: the pauses, the withdrawals and the canvas switch are
// rules the browser has to receive, and a mixin that emitted nothing would be an effect that keeps
// running offscreen, behind high-contrast text, or under a canvas that never shows.

import { describe, expect, test } from 'bun:test';

interface SassApi {
  compileString(source: string, options: { readonly url: URL }): { readonly css: string };
}

const UI_TOKENS = Bun.fileURLToPath(new URL('../../ui/src/tokens/_index.scss', import.meta.url));
const RENDER = Bun.fileURLToPath(new URL('../../render', import.meta.url));
// `sass` is `@ultimat3/render`'s dependency, resolved from there so one compiler is the one pinned.
const sass = (await import(Bun.resolveSync('sass', RENDER))) as SassApi;

async function compile(dir: string, file: string): Promise<string> {
  const path = Bun.fileURLToPath(new URL(`./${dir}/${file}`, import.meta.url));
  const source = (await Bun.file(path).text()).replace('@ultimat3/ui/tokens', UI_TOKENS);
  return sass.compileString(source, { url: Bun.pathToFileURL(path) }).css.replace(/\s+/g, ' ');
}

const SHEETS = [
  ['aurora', 'Aurora.module.scss'],
  ['gradient-orbs', 'GradientOrbs.module.scss'],
  ['grid-glow', 'GridGlow.module.scss'],
  ['noise', 'Noise.module.scss'],
  ['mosaic-grid', 'MosaicGrid.module.scss'],
  ['shader-background', 'ShaderBackground.module.scss'],
  ['effect-canvas', 'EffectCanvas.module.scss'],
] as const;

const css = new Map<string, string>();
for (const [dir, file] of SHEETS) css.set(dir, await compile(dir, file));
const sheet = (dir: string): string => css.get(dir) ?? expect.unreachable(`no sheet for ${dir}`);

describe('styles · backgrounds', () => {
  test('no sheet writes a colour or a duration of its own', () => {
    for (const [dir] of SHEETS) {
      expect(sheet(dir)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i);
      expect(sheet(dir)).not.toMatch(/animation:[^;]*\b\d+m?s\b/);
    }
  });

  test('every CSS animation holds offscreen and in a hidden tab', () => {
    for (const dir of ['aurora', 'gradient-orbs', 'grid-glow']) {
      expect(sheet(dir)).toMatch(
        /\.root\[data-effect-paused\] \.[a-z]+ \{ animation-play-state: paused/,
      );
    }
  });

  test("the MotionToggle pause is ui's global guard, which lands on the base frame (no fill)", async () => {
    const motion = await Bun.file(
      new URL('../../ui/src/tokens/_motion.scss', import.meta.url),
    ).text();
    expect(motion).toContain("html[data-motion='paused']");
    for (const [dir] of SHEETS)
      expect(sheet(dir)).not.toMatch(/animation-fill-mode|animation:[^;]*\b(?:forwards|both)\b/);
  });

  test('GradientOrbs animates transform and opacity only', () => {
    const keyframes = sheet('gradient-orbs').match(/@keyframes[^{]*\{(.*?\})\s*\}/)?.[1] ?? '';
    const properties = [...keyframes.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
    expect(new Set(properties)).toEqual(new Set(['transform', 'opacity']));
  });

  test("GridGlow extends ui's grid-texture and withdraws grid and glow for high contrast", () => {
    const grid = sheet('grid-glow');
    expect(grid).toContain('repeating-linear-gradient');
    expect(grid.match(/prefers-contrast: more/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test('Noise withdraws under prefers-contrast and forced colours', () => {
    expect(sheet('noise')).toMatch(/prefers-contrast: more\), \(forced-colors: active\)/);
  });

  test('a canvas shows only under a canvas backend, and the frame under it hides then', () => {
    for (const dir of ['mosaic-grid', 'shader-background', 'effect-canvas']) {
      expect(sheet(dir)).toContain('[data-effect-backend=canvas]');
      expect(sheet(dir)).toContain('[data-effect-backend=webgl2]');
      expect(sheet(dir)).toContain('visibility: hidden');
      expect(sheet(dir)).toContain('visibility: visible');
    }
  });

  test('grain hides its SVG grain only where the shader draws its own', () => {
    expect(sheet('shader-background')).toMatch(
      /\[data-effect-backend=webgl2\] \.layer > \.grain-overlay \{ display: none/,
    );
  });
});
