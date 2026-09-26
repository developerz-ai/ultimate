// The reset makes two claims a component header repeats, and a stylesheet cannot be asserted
// through a render — there is no CSS engine in this process. So the source is what is read: a
// claim in a `.tsx` header that no rule backs is the failure mode this file exists to catch.

import { describe, expect, test } from 'bun:test';

const RESET = new URL('./reset.scss', import.meta.url).pathname;
const DIALOG = new URL('../components/Dialog.tsx', import.meta.url).pathname;

describe('reset.scss', () => {
  test('locks body scroll behind a modal surface, which Dialog and Drawer both rely on', async () => {
    const css = await Bun.file(RESET).text();
    const rule = /html:has\(dialog:modal\)\s*\{[^}]*overflow:\s*hidden/;
    // `Dialog`'s header sold body scroll locking and nothing implemented it, so wheeling over the
    // backdrop scrolled the page behind an open dialog. `:modal`, not `[open]`: a non-modal
    // <dialog> shown with `show()` must not freeze the page.
    expect(rule.test(css)).toBe(true);
  });

  test('keeps the UA centring of a <dialog>, which the universal margin reset would otherwise erase', async () => {
    const css = await Bun.file(RESET).text();
    // `* { margin: 0 }` beats the UA's `dialog { margin: auto }`; without this rule a modal opens
    // pinned to the top-left corner of the viewport, and every app restated the margin itself.
    expect(/:where\(dialog\)\s*\{[^}]*margin:\s*auto/.test(css)).toBe(true);
  });

  test('Dialog points at where the lock actually lives, rather than claiming to do it', async () => {
    const source = await Bun.file(DIALOG).text();
    expect(source).toContain('tokens/reset.scss');
  });
});

type Specificity = readonly [ids: number, classes: number, types: number];

/**
 * Selectors Level 4 specificity, for the subset a reset writes. `:where(…)` counts nothing, whole;
 * `:not(…)` / `:is(…)` / `:has(…)` count their argument (a single argument here, so the max is the
 * argument itself); `*` counts nothing.
 */
function specificity(selector: string): Specificity {
  let rest = withoutWhere(selector);
  rest = rest.replace(/:(not|is|has)\(/g, ' (').replace(/[()]/g, ' ');
  let classes = 0;
  let types = 0;
  rest = rest.replace(/\[[^\]]*\]/g, () => {
    classes += 1;
    return ' ';
  });
  rest = rest.replace(/::[\w-]+/g, () => {
    types += 1;
    return ' ';
  });
  rest = rest.replace(/:[\w-]+/g, () => {
    classes += 1;
    return ' ';
  });
  let ids = 0;
  rest = rest.replace(/#[\w-]+/g, () => {
    ids += 1;
    return ' ';
  });
  rest = rest.replace(/\.[\w-]+/g, () => {
    classes += 1;
    return ' ';
  });
  types += (rest.match(/[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, types];
}

/** Drop every `:where(…)` group whole, its nested parentheses with it. */
function withoutWhere(selector: string): string {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    if (selector.startsWith(':where(', i)) {
      let depth = 0;
      i += ':where'.length;
      do {
        if (selector[i] === '(') depth += 1;
        if (selector[i] === ')') depth -= 1;
        i += 1;
      } while (i < selector.length && depth > 0);
      out += ' ';
      continue;
    }
    out += selector[i];
    i += 1;
  }
  return out;
}

interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: string;
}

/** Split on commas that are not inside parentheses — `:where(h1, h2)` is ONE selector. */
function splitSelectors(prelude: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of prelude) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  out.push(current.trim());
  return out.filter((selector) => selector.length > 0);
}

/**
 * Every style rule OUTSIDE an at-rule, with Sass nesting resolved (`&` → the parent, a bare nested
 * selector → a descendant). The reduced-motion guard lives in `@media` and is meant to win, so an
 * at-rule's block is skipped whole; `@use` / `@include` statements carry no selector.
 */
function rulesOf(source: string): readonly Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const rules: Rule[] = [];
  const walk = (from: number, parents: readonly string[]): number => {
    let i = from;
    let buffer = '';
    let declarations = '';
    while (i < text.length) {
      const char = text[i];
      if (char === '{') {
        const prelude = buffer.trim();
        buffer = '';
        if (prelude.startsWith('@')) {
          let depth = 1;
          i += 1;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth += 1;
            if (text[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        const own = splitSelectors(prelude);
        const selectors =
          parents.length === 0
            ? own
            : parents.flatMap((parent) =>
                own.map((child) =>
                  child.includes('&') ? child.replaceAll('&', parent) : `${parent} ${child}`,
                ),
              );
        const inner: Rule[] = [];
        const before = rules.length;
        i = walk(i + 1, selectors);
        inner.push(...rules.splice(before));
        rules.push({ selectors, declarations: lastDeclarations }, ...inner);
        continue;
      }
      if (char === '}') {
        lastDeclarations = `${declarations}${buffer}`;
        return i + 1;
      }
      if (char === ';') {
        const statement = `${buffer};`;
        buffer = '';
        if (!statement.trim().startsWith('@')) declarations += statement;
        i += 1;
        continue;
      }
      buffer += char;
      i += 1;
    }
    return i;
  };
  let lastDeclarations = '';
  walk(0, []);
  return rules;
}

/**
 * The rules meant to OUTRANK a component, or that cannot be wrapped — each with its reason. Every
 * other selector in the reset is (0,0,0).
 */
const SPECIFIC_ON_PURPOSE: ReadonlyMap<string, string> = new Map([
  ['*::before', 'box-sizing only; a pseudo-element cannot sit inside :where()'],
  ['*::after', 'box-sizing only; a pseudo-element cannot sit inside :where()'],
  [
    '::selection',
    'a pseudo-element cannot sit inside :where(); `.x::selection` (0,1,1) still wins',
  ],
  ['html:has(dialog:modal)', 'the modal scroll lock is meant to win'],
  ['.ultimate-live-region', 'the one class the package owns, created by announce()'],
]);

describe('reset.scss is zero-specificity', () => {
  test('the specificity helper counts what a browser counts', () => {
    expect(specificity('a:hover')).toEqual([0, 1, 1]);
    expect(specificity(':where(a):hover')).toEqual([0, 1, 0]);
    expect(specificity(':where(a:hover)')).toEqual([0, 0, 0]);
    expect(specificity('.primary')).toEqual([0, 1, 0]);
    expect(specificity(':focus:not(:focus-visible)')).toEqual([0, 2, 0]);
    expect(specificity(':where(:focus:not(:focus-visible))')).toEqual([0, 0, 0]);
    expect(specificity('html:has(dialog:modal)')).toEqual([0, 1, 2]);
    expect(specificity('*')).toEqual([0, 0, 0]);
  });

  test('the nested-rule reader resolves `&`, so a nested `&:hover` cannot hide', () => {
    const rules = rulesOf('a { color: red; &:hover { color: blue; } }');
    expect(rules.map((rule) => rule.selectors)).toEqual([['a'], ['a:hover']]);
    expect(rules[1]?.declarations).toContain('color: blue');
  });

  /**
   * The defect, measured on notificado.co: `a:hover` (0,1,1) beat `.primary:hover`'s missing
   * `color` AND `.primary`'s own `color` (0,1,0), so an `<a class="primary">` — a filled button
   * link — turned its text accent-strong on an accent-strong hover background. Any class-styled
   * link that set `color` only in its base rule had the bug.
   */
  test('no rule that colours a link outranks a single class', async () => {
    const rules = rulesOf(await Bun.file(RESET).text());
    const linkColours = rules.filter(
      (rule) =>
        /(^|;)\s*color\s*:/.test(rule.declarations) &&
        rule.selectors.some((selector) => /(^|[\s(,>+~])a(?![\w-])/.test(selector)),
    );
    expect(linkColours.length).toBeGreaterThan(0);
    for (const rule of linkColours) {
      for (const selector of rule.selectors)
        expect([selector, specificity(selector)]).toEqual([selector, [0, 0, 0]]);
    }
  });

  test('every other rule is (0,0,0) too — any single class beats the reset', async () => {
    const rules = rulesOf(await Bun.file(RESET).text());
    const specific = rules
      .flatMap((rule) => rule.selectors)
      .filter((selector) => !SPECIFIC_ON_PURPOSE.has(selector))
      .filter((selector) => specificity(selector).some((count) => count > 0));
    expect(specific).toEqual([]);
  });
});
