// The seven interaction/text entries' stylesheets, COMPILED: a rule written but never emitted (a
// media query that fell away, a mixin that wrote nothing) is an effect that silently does not
// happen, and no unit test of the view would notice.

import { describe, expect, test } from 'bun:test';

interface SassApi {
  compileString(source: string, options: { readonly url: URL }): { readonly css: string };
}

const UI_TOKENS = Bun.fileURLToPath(new URL('../../../ui/src/tokens/_index.scss', import.meta.url));
const RENDER = Bun.fileURLToPath(new URL('../../../render', import.meta.url));

// `sass` is `@ultimat3/render`'s dependency, resolved from there so one compiler is the one pinned.
const sass = (await import(Bun.resolveSync('sass', RENDER))) as SassApi;

async function compile(entry: string, file: string): Promise<string> {
  const path = Bun.fileURLToPath(new URL(`../${entry}/${file}`, import.meta.url));
  const source = (await Bun.file(path).text()).replace('@ultimat3/ui/tokens', UI_TOKENS);
  return sass.compileString(source, { url: Bun.pathToFileURL(path) }).css.replace(/\s+/g, ' ');
}

describe('SpotlightCard', () => {
  test('the highlight shows on hover AND on keyboard focus, and is withdrawn for high contrast', async () => {
    const css = await compile('spotlight-card', 'SpotlightCard.module.scss');
    expect(css).toContain('.card:hover');
    expect(css).toContain(':has(:focus-visible)');
    expect(css).toContain('prefers-contrast: more');
  });
});

describe('Tilt', () => {
  test('coarse pointers get no transform', async () => {
    const css = await compile('tilt', 'Tilt.module.scss');
    expect(css).toContain('pointer: coarse');
    expect(css).toContain('transform: none');
  });
});

describe('GlassSurface', () => {
  test('extends the surface mixin and goes opaque under reduced transparency', async () => {
    const css = await compile('glass-surface', 'GlassSurface.module.scss');
    expect(css).toContain('border: 1px solid');
    expect(css).toContain('backdrop-filter: blur(var(--glass-blur))');
    expect(css).toMatch(
      /prefers-reduced-transparency: reduce[^{]*\{ \.glass \{ background: rgb\(var\(--color-surface\)\/1\); backdrop-filter: none;/,
    );
  });
});

describe('Marquee', () => {
  test('pauses on hover, focus-within and the MotionToggle; flips for RTL; stills for reduced motion', async () => {
    const css = await compile('marquee', 'Marquee.module.scss');
    expect(css).toContain('.root:hover .track');
    expect(css).toContain('.root:focus-within .track');
    expect(css).toContain(":global(html[data-motion='paused']) .track");
    expect(css).toContain(':dir(rtl)');
    expect(css).toMatch(/prefers-reduced-motion: reduce.*animation: none/);
  });
});

describe('TextReveal', () => {
  test('the readable node is visually hidden, the pieces stagger by index', async () => {
    const css = await compile('text-reveal', 'TextReveal.module.scss');
    expect(css).toContain('clip-path: inset(50%)');
    expect(css).toContain('animation-delay: calc(var(--i) * var(--reveal-step, 40ms))');
  });
});

describe('Shimmer', () => {
  test('consumes the ui mixin (same keyframes Skeleton paints) and clips to the text', async () => {
    const css = await compile('shimmer', 'Shimmer.module.scss');
    expect(css).toContain('@keyframes ultimate-shimmer');
    expect(css).toContain('animation: ultimate-shimmer');
    expect(css).toContain('background-clip: text');
    expect(css).toContain('forced-colors: active');
  });
});
