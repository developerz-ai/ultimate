// `_mixins.scss` and `_units.scss` are authoring surface: every component stylesheet `@include`s
// from them, so a defect in one helper is a defect in every sheet that composes it. Two seams, one
// per kind of claim. A helper that COMPUTES — a media query, a `clamp()`, an `@error` — is compiled
// and its output read, because arithmetic and a refusal exist only after Sass has run. A mixin that
// only DECLARES is read as source, the same seam and the same reason as `reset.test.ts`.

import { describe, expect, test } from 'bun:test';
import { hasErrorCode } from '@ultimat3/core';
import '../errors';
import { compileScss, scssRefusal } from '../sass-probe';

const TOKENS = new URL('.', import.meta.url).pathname;
const MIXINS = `${TOKENS}_mixins.scss`;

/** One stylesheet using the token entry point exactly as an app does: `@use … as t`. */
const sheet = (body: string): string => `@use './index' as t;\n${body}`;
const AT = `${TOKENS}__compiled.scss`;

/** Compiled CSS on one line, so an assertion reads like the rule it expects. */
const css = async (body: string): Promise<string> =>
  (await compileScss(sheet(body), AT)).replace(/\s+/g, ' ').trim();

/** A declaration's value: `value('t.rem(24px)')` is what `x: t.rem(24px)` compiled to. */
const value = async (expression: string): Promise<string> =>
  /x: (.*); \}$/.exec(await css(`.a { x: ${expression}; }`))?.[1] ??
  expect.unreachable(`${expression} compiled to no declaration`);

/** The `@error` text a stylesheet is refused with. Compiling at all is the failure. */
const refusal = async (body: string): Promise<string> =>
  (await scssRefusal(sheet(body), AT)) ?? expect.unreachable(`expected Sass to refuse: ${body}`);

const within = (mixin: string): string => `.a { @include t.${mixin} { color: inherit; } }`;

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

describe('the breakpoint mixins, compiled', () => {
  test('respond-to is the min-width arm of a named rung', async () => {
    expect(await css(within('respond-to(md)'))).toBe(
      '@media (min-width: 768px) { .a { color: inherit; } }',
    );
  });

  /**
   * `2xl` in a Sass map is the NUMBER 2 with the unit `xl`, so a map lookup by the string every
   * app writes — `respond-to('2xl')` — missed, and the mixin answered "breakpoint "2xl" is not in
   * $breakpoints" about a rung that is in it. Shipped that way until 2026-10.
   */
  test('a quoted rung and a bare one are the same rung, 2xl included', async () => {
    for (const rung of ["'2xl'", '2xl', '"2xl"']) {
      expect(await css(within(`respond-to(${rung})`))).toStartWith('@media (min-width: 1536px)');
    }
    expect(await css(within("respond-down('2xl')"))).toStartWith('@media (max-width: 1535.98px)');
  });

  test('respond-down stops 0.02px under the rung, so it never overlaps respond-to', async () => {
    expect(await css(within('respond-down(md)'))).toBe(
      '@media (max-width: 767.98px) { .a { color: inherit; } }',
    );
  });

  test('respond-between is min-width at $from and 0.02px under $to', async () => {
    expect(await css(within('respond-between(md, lg)'))).toBe(
      '@media (min-width: 768px) and (max-width: 1023.98px) { .a { color: inherit; } }',
    );
  });

  test('an unknown rung is X_TOKEN_UNKNOWN naming the mixin, the rung and every rung that exists', async () => {
    for (const mixin of ['respond-to', 'respond-down']) {
      const message = await refusal(within(`${mixin}(wide)`));
      expect(message).toStartWith(`X_TOKEN_UNKNOWN: ${mixin}("wide")`);
      expect(message).toEndWith('fix: use one of sm, md, lg, xl, 2xl');
    }
    expect(await refusal(within('respond-between(md, wide)'))).toStartWith(
      'X_TOKEN_UNKNOWN: respond-between("wide")',
    );
    expect(await refusal(within('respond-between(narrow, lg)'))).toStartWith(
      'X_TOKEN_UNKNOWN: respond-between("narrow")',
    );
  });

  test('respond-between refuses a reversed range and names the swap', async () => {
    const message = await refusal(within('respond-between(lg, md)'));
    expect(message).toStartWith('X_UI_INVALID_VALUE: respond-between("lg", "md")');
    expect(message).toEndWith('fix: write respond-between("md", "lg")');
  });

  test('respond-between refuses an empty range and names the mixin that means it', async () => {
    const message = await refusal(within('respond-between(md, md)'));
    expect(message).toStartWith('X_UI_INVALID_VALUE: respond-between("md", "md")');
    expect(message).toEndWith('fix: write respond-to("md"), or name a higher rung as $to');
  });
});

describe('rem(), compiled', () => {
  test('px, a unitless px count and rem all answer in rem', async () => {
    expect(await value('t.rem(24px)')).toBe('1.5rem');
    expect(await value('t.rem(24)')).toBe('1.5rem');
    expect(await value('t.rem(1.5rem)')).toBe('1.5rem');
  });

  test('a stated root divides both the px and the unitless form', async () => {
    expect(await value('t.rem(20px, 10px)')).toBe('2rem');
    expect(await value('t.rem(20, 10px)')).toBe('2rem');
  });

  test('a wrong unit is refused with the call to write instead', async () => {
    const message = await refusal('.a { x: t.rem(2em); }');
    expect(message).toStartWith(
      'X_UI_INVALID_VALUE: rem() expected px, rem or a unitless px count',
    );
    expect(message).toContain('2em');
    expect(message).toEndWith('fix: pass a px length, e.g. rem(24px)');
  });

  test('a value that is not a number is the same refusal, never a Sass internal', async () => {
    expect(await refusal(".a { x: t.rem('wide'); }")).toStartWith(
      'X_UI_INVALID_VALUE: rem() expected',
    );
  });
});

describe('fluid(), compiled', () => {
  /** `clamp(<min>rem, calc(<intercept>rem + <slope>vw), <max>rem)` as numbers. */
  async function parts(expression: string): Promise<readonly [number, number, number, number]> {
    const clamp = await value(expression);
    const found = /^clamp\(([\d.]+)rem, (-?[\d.]+)rem ([+-]) ([\d.]+)vw, ([\d.]+)rem\)$/.exec(
      clamp,
    );
    if (found === null) return expect.unreachable(`not a rem clamp: ${clamp}`);
    const slope = Number(found[4]) * (found[3] === '-' ? -1 : 1);
    return [Number(found[1]), Number(found[2]), slope, Number(found[5])];
  }

  /** The preferred value at a viewport `width` rem wide: 1vw is a hundredth of it. */
  const at = (intercept: number, slope: number, width: number): number =>
    intercept + (slope * width) / 100;

  test('the line passes through $min at $from and $max at $to', async () => {
    const [min, intercept, slope, max] = await parts('t.fluid(1rem, 2rem, 20rem, 80rem)');
    expect([min, max]).toEqual([1, 2]);
    expect(at(intercept, slope, 20)).toBeCloseTo(1, 6);
    expect(at(intercept, slope, 80)).toBeCloseTo(2, 6);
  });

  test('px arguments are the same clamp as their rem equivalents', async () => {
    expect(await value('t.fluid(16px, 32px, 320px, 1280px)')).toBe(
      await value('t.fluid(1rem, 2rem, 20rem, 80rem)'),
    );
  });

  test('the viewport range defaults to 20rem → 80rem', async () => {
    expect(await value('t.fluid(1rem, 2rem)')).toBe(
      await value('t.fluid(1rem, 2rem, 20rem, 80rem)'),
    );
  });

  /**
   * `clamp(MIN, VAL, MAX)` with MIN above MAX resolves to MIN at every width, so a size meant to
   * SHRINK as the viewport grows would compile and never move.
   */
  test('a size that shrinks keeps its bounds in order', async () => {
    const [min, intercept, slope, max] = await parts('t.fluid(2rem, 1rem, 20rem, 80rem)');
    expect([min, max]).toEqual([1, 2]);
    expect(slope).toBeLessThan(0);
    expect(at(intercept, slope, 20)).toBeCloseTo(2, 6);
    expect(at(intercept, slope, 80)).toBeCloseTo(1, 6);
  });

  test('an empty or reversed viewport range is refused', async () => {
    for (const range of ['20rem, 20rem', '80rem, 20rem']) {
      const message = await refusal(`.a { x: t.fluid(1rem, 2rem, ${range}); }`);
      expect(message).toStartWith('X_UI_INVALID_VALUE: fluid() needs $from below $to');
      expect(message).toEndWith(
        'fix: pass the narrower viewport first, e.g. fluid(1rem, 2rem, 20rem, 80rem)',
      );
    }
  });

  test('a wrong unit is refused in the name of the function that was called', async () => {
    const message = await refusal('.a { x: t.fluid(1vw, 2rem); }');
    expect(message).toStartWith(
      'X_UI_INVALID_VALUE: fluid() expected px, rem or a unitless px count',
    );
    expect(message).toEndWith('fix: pass a px length, e.g. fluid(16px, 32px)');
  });
});

describe('the token entry point', () => {
  /** Every module is its own compilation: a rule emitted here would be inlined once per sheet. */
  test('emits no CSS until a helper is used', async () => {
    expect(await compileScss(sheet(''), AT)).toBe('');
  });

  /**
   * A Sass `@error` is not an `UltimateError`, so nothing but this holds its code to the registry:
   * `x errors explain <CODE>` has to answer for a code a stylesheet build prints.
   */
  test('every @error names a registered code, and says how to fix it', async () => {
    const errors: string[] = [];
    for (const file of new Bun.Glob('_*.scss').scanSync({ cwd: TOKENS })) {
      const source = await Bun.file(`${TOKENS}${file}`).text();
      // Unquoted, or Sass prints the message wrapped in quotes and `X_` is no longer where a
      // reader — or a grep — looks for it.
      const refusals = [...source.matchAll(/@error string\.unquote\('([^']*)'\);/g)];
      expect(`${file}: ${refusals.length}`).toBe(`${file}: ${source.split('@error ').length - 1}`);
      errors.push(...refusals.map((match) => match[1] as string));
    }
    expect(errors.length).toBeGreaterThanOrEqual(5);
    for (const message of errors) {
      const code = /^(X_[A-Z0-9_]+): /.exec(message)?.[1];
      expect(code === undefined ? message : hasErrorCode(code)).toBe(true);
      expect(message).toContain(' fix: ');
    }
  });
});
