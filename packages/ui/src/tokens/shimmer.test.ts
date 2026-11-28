// The shimmer mixin, COMPILED: Skeleton and effects' Shimmer share one sweep, so its gradient,
// its keyframes and its timing are pinned here and not restated per component.

import { describe, expect, test } from 'bun:test';
import { compileScss } from '../sass-probe-fixture';

const AT = `${Bun.fileURLToPath(new URL('.', import.meta.url))}__compiled.scss`;
const css = async (body: string): Promise<string> =>
  (await compileScss(`@use './index' as t;\n${body}`, AT)).replace(/\s+/g, ' ').trim();

describe('shimmer', () => {
  test('sweeps a role-built gradient on the slower duration, with its own keyframes', async () => {
    const out = await css('.a { @include t.shimmer; }');
    expect(out).toContain('linear-gradient(90deg, rgb(var(--color-bg-soft)/1) 25%');
    expect(out).toContain('rgb(var(--color-line)/1) 37%');
    expect(out).toContain('background: linear-gradient');
    expect(out).toContain('0 0/200% 100%');
    expect(out).toContain(
      'animation: ultimate-shimmer calc(var(--duration-slower) * 2) linear infinite',
    );
    expect(out).toMatch(/@keyframes ultimate-shimmer \{ to \{ background-position: -200% 0; \} \}/);
  });

  test('the two roles are parameters', async () => {
    const out = await css(".a { @include t.shimmer($base: 'bg', $glint: 'accent'); }");
    expect(out).toContain('rgb(var(--color-bg)/1) 25%');
    expect(out).toContain('rgb(var(--color-accent)/1) 37%');
  });
});
