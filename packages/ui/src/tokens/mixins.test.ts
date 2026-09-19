// `_mixins.scss` is authoring surface: eight component stylesheets `@include` from it, so a
// defect in one mixin is a defect in every component that composes it. There is no CSS engine in
// this process, so the SOURCE is what is read — the same seam, and the same reason, as
// `reset.test.ts`: a claim a rule does not back is what these files exist to catch.

import { describe, expect, test } from 'bun:test';

const MIXINS = new URL('./_mixins.scss', import.meta.url).pathname;

/** One mixin's declarations. Non-total on purpose: a name this file does not declare is a typo in
 * the test, and `expect.unreachable` says so where an empty string would pass every assertion. */
async function body(name: string): Promise<string> {
  const source = await Bun.file(MIXINS).text();
  // Parameter lists may nest parentheses (`$pitch: space.space(5)`), so the list is skipped up
  // to the first `{` rather than parsed.
  const found = new RegExp(String.raw`@mixin ${name}[^{]*\{([^}]*)\}`).exec(source);
  return found?.[1] ?? expect.unreachable(`_mixins.scss declares no @mixin ${name}`);
}

describe('visually-hidden', () => {
  /**
   * The defect, and it is a LAYOUT one rather than an accessibility one. `position: absolute` with
   * no inset leaves the box at its static position and only takes it out of flow; after a long run
   * of inline text that position is already past the viewport edge, and the box escapes the
   * truncating ancestor's `overflow: hidden` because that ancestor is not positioned and so is not
   * its containing block. Measured in ai-maxxing: `Link`'s `.hint` after truncated titles put
   * seven boxes at right edges of 753–1119px, making the document 1119px wide in a 390px viewport
   * and 1480px in a 1440px one. Verified in a browser at both sizes after the fix —
   * `document.documentElement.scrollWidth === clientWidth`.
   */
  test('leaves the static position, so it cannot widen the document it annotates', async () => {
    expect(await body('visually-hidden')).toMatch(/inset-inline-start:\s*0/);
  });

  /**
   * The file's own header: "nothing in a component stylesheet hardcodes a colour, a physical
   * direction, or a breakpoint value". `left: -9999px` is the classic idiom for this mixin and it
   * is the one this rule refuses — it reads as correct, and in an RTL document it parks the box a
   * screen away on the side the content is not.
   */
  test('says it logically — a physical inset would be right for one writing mode only', async () => {
    expect(await body('visually-hidden')).not.toMatch(/^\s*(left|right):/m);
  });

  /**
   * Non-vacuity, and the reason the two assertions above are not enough on their own: a mixin that
   * had lost `clip-path` would still satisfy both while announcing nothing to a screen reader and
   * showing a 1px sliver to everyone else. This is the property the mixin is NAMED for.
   */
  test('still hides what it hides', async () => {
    const declarations = await body('visually-hidden');
    expect(declarations).toMatch(/position:\s*absolute/);
    expect(declarations).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(declarations).toMatch(/width:\s*1px/);
    expect(declarations).toMatch(/height:\s*1px/);
  });
});

describe('data-text', () => {
  test('is the mono family with tabular figures — columns of data must not wobble', async () => {
    const css = await body('data-text');
    expect(css).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe('label-caps', () => {
  test('sets size, weight and tracking from tokens, never a raw value', async () => {
    const css = await body('label-caps');
    expect(css).toMatch(/typography\.text\('xs'\)/);
    expect(css).toMatch(/typography\.weight\('medium'\)/);
    expect(css).toMatch(/typography\.tracking\('wide'\)/);
    expect(css).toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/\d+(px|rem|em)/);
  });
});

describe('dot-grid', () => {
  test('draws every layer from a colour role, so the ground themes with the page', async () => {
    const css = await body('dot-grid');
    expect(css).toMatch(/colors\.role\('line'/);
    expect(css).toMatch(/colors\.role\('bg-soft'\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
