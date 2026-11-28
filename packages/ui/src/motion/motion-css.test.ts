// What `theme.scss` EMITS for motion, compiled by Sass: the spring rungs with their pre-`linear()`
// fallback, the view-transition timing, and the page-wide pause `<MotionToggle>` switches on.

import { describe, expect, test } from 'bun:test';
import { compileScss, compileScssFile, scssRefusal } from '../sass-probe-fixture';
import { springs } from '../tokens/tokens';

const css = (): Promise<string> =>
  compileScssFile(Bun.fileURLToPath(new URL('../tokens/theme.scss', import.meta.url)));

describe('theme.scss motion output', () => {
  test('each spring rung is the cubic-bezier spring, then its linear() curve under @supports', async () => {
    const out = await css();
    const supports = out.indexOf('@supports (transition-timing-function: linear(0, 1))');
    expect(supports).toBeGreaterThan(-1);
    for (const [name, rung] of Object.entries(springs)) {
      const fallback = out.indexOf(`--easing-${name}: cubic-bezier(0.34, 1.56, 0.64, 1);`);
      expect(fallback).toBeGreaterThan(-1);
      expect(fallback).toBeLessThan(supports);
      expect(out.indexOf(`--easing-${name}: ${rung.easing};`)).toBeGreaterThan(supports);
    }
  });

  test('a paused page lands every animation and transition on its end state, never frozen', async () => {
    const out = await css();
    const paused = out.slice(out.indexOf('html[data-motion=paused] *'));
    expect(paused).toContain('animation-duration: 0.01ms !important');
    expect(paused).toContain('transition-duration: 0.01ms !important');
    expect(out).not.toContain('animation-play-state');
    expect(out).toContain('html[data-motion=paused]::view-transition-group(*)');
  });

  test('a view transition runs on the duration and easing tokens', async () => {
    const out = await css();
    const group = out.slice(out.indexOf('::view-transition-group(*),'));
    expect(group).toContain('animation-duration: var(--duration-base)');
    expect(group).toContain('animation-timing-function: var(--easing-out)');
  });
});

describe('@mixin view-transition-name', () => {
  const TOKENS = Bun.fileURLToPath(new URL('../tokens/', import.meta.url));
  const AT = `${TOKENS}__vt-probe.scss`;
  const sheet = (body: string): string => `@use './index' as t;\n${body}`;

  test('names the element, quoted or bare', async () => {
    for (const name of ['post-card', "'post-card'"]) {
      const out = await compileScss(sheet(`.a { @include t.view-transition-name(${name}); }`), AT);
      expect(out.replace(/\s+/g, ' ')).toContain('.a { view-transition-name: post-card; }');
    }
  });

  test('anything but an identifier is X_UI_INVALID_VALUE with a fix', async () => {
    const refused = await scssRefusal(sheet('.a { @include t.view-transition-name(12px); }'), AT);
    expect(refused).toContain('X_UI_INVALID_VALUE');
    expect(refused).toContain('fix:');
  });
});
