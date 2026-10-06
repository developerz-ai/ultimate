// What the chart sheets EMIT, compiled with the app build's own Sass: the container queries that
// make one server render serve a 390px phone and a 1440px desktop, the colour slots, and strokes
// that do not scale. A markup test can only show the flags; this is where the flags are obeyed.

import { describe, expect, test } from 'bun:test';
import { compileScssFile } from '../sass-probe-fixture';

const COMPONENTS = Bun.fileURLToPath(new URL('.', import.meta.url));
const sheet = (name: string): Promise<string> => compileScssFile(`${COMPONENTS}${name}`);

/** The PHONE the plan names: an iPhone 14's 390 CSS px, the whole viewport and then some. */
const PHONE_PX = 390;

/** The body of the `@container <name> (min-width: N)` block, and N in px at the 16px root. */
function containerBlock(
  css: string,
  name: string,
): { readonly minPx: number; readonly body: string } {
  const match = new RegExp(`@container ${name} \\(min-width: ([\\d.]+)rem\\) \\{`).exec(css);
  if (match === null) return { minPx: Number.NaN, body: '' };
  let depth = 1;
  let at = match.index + match[0].length;
  const start = at;
  while (depth > 0 && at < css.length) {
    if (css[at] === '{') depth += 1;
    if (css[at] === '}') depth -= 1;
    at += 1;
  }
  return { minPx: Number(match[1]) * 16, body: css.slice(start, at - 1) };
}

/** Declarations of the top-level rule whose whole selector is `selector`. */
function ruleBody(css: string, selector: string): string {
  const at = css.startsWith(`${selector} {`) ? 0 : css.indexOf(`\n${selector} {`);
  if (at < 0) return '';
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe('LineChart.module.scss at 390px and at 1440px', () => {
  test('narrow is the default: wide-only key labels and minor value labels are hidden', async () => {
    const css = await sheet('LineChart.module.scss');
    expect(ruleBody(css, '.key[data-narrow=false]')).toContain('display: none');
    expect(ruleBody(css, '.tick[data-minor=true]')).toContain('visibility: hidden');
  });

  test('the wide rules only start above a phone’s whole width, and swap the label tiers', async () => {
    const { minPx, body } = containerBlock(await sheet('LineChart.module.scss'), 'line-chart');
    expect(minPx).toBeGreaterThan(PHONE_PX);
    // …and below a desktop tile's width, so 1440 gets six labels.
    expect(minPx).toBeLessThan(720);
    expect(body).toMatch(/\.key\[data-wide=false\] \{\s*display: none/);
    expect(body).toMatch(/\.key\[data-narrow=false\] \{\s*display: block/);
    expect(body).toMatch(/\.tick\[data-minor=true\] \{\s*visibility: visible/);
  });

  test('the chart is its own query container, so density follows the plot and not the page', async () => {
    const css = await sheet('LineChart.module.scss');
    expect(ruleBody(css, '.chart')).toContain('container-name: line-chart');
    expect(ruleBody(css, '.chart')).toContain('container-type: inline-size');
  });

  test('every stroke keeps its width when the svg is stretched', async () => {
    const css = await sheet('LineChart.module.scss');
    for (const selector of ['.grid', '.line', '.marker']) {
      expect([selector, ruleBody(css, selector)]).toEqual([
        selector,
        expect.stringContaining('vector-effect: non-scaling-stroke'),
      ]);
    }
  });
});

describe('ChartFrame.module.scss', () => {
  test('the legend wraps under the plot by default and stands beside it on a wide frame', async () => {
    const css = await sheet('ChartFrame.module.scss');
    expect(ruleBody(css, '.legend')).toContain('flex-wrap: wrap');
    const { minPx, body } = containerBlock(css, 'chart-frame');
    expect(minPx).toBeGreaterThan(PHONE_PX);
    expect(body).toContain('grid-template-columns');
    expect(body).toMatch(/\.withLegend \.legend \{\s*flex-direction: column/);
  });

  test('the eight colour slots read the chart roles, one data-series value each', async () => {
    const css = await sheet('ChartFrame.module.scss');
    for (let slot = 1; slot <= 8; slot += 1) {
      expect(css).toContain(
        `.frame [data-series="${slot}"] {\n  --series: rgb(var(--color-chart-${slot})/1);`,
      );
    }
  });

  test('a readout shows on hover and on keyboard focus alike, with no script', async () => {
    const css = await sheet('ChartFrame.module.scss');
    expect(css).toMatch(
      /\.hit:hover > \.readout, \.hit:focus-visible > \.readout \{\s*visibility: visible/,
    );
  });
});
