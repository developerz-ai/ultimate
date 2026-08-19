// Emitted source has to be the bytes Biome would leave behind, because the scaffolded app's own
// `lint` step runs on it. The three behaviours measured against Biome 2.5.8 are the contract:
// upper before lower on a case tie, case only as a tiebreak, and a digit run compared as a number.

import { describe, expect, test } from 'bun:test';
import { LINE_WIDTH, sortSpecifiers, wrapImport, wrapList } from './wrap';

describe('sortSpecifiers', () => {
  test('a digit run compares as a number, so b2 precedes b10', () => {
    expect(sortSpecifiers(['b10', 'b2'])).toEqual(['b2', 'b10']);
    expect(sortSpecifiers(['step10', 'step9', 'step1'])).toEqual(['step1', 'step9', 'step10']);
  });

  test('equal digit runs fall through to the characters after them', () => {
    expect(sortSpecifiers(['v2beta', 'v2alpha'])).toEqual(['v2alpha', 'v2beta']);
    // Same number written with a leading zero: the values tie, so the compare continues.
    expect(sortSpecifiers(['a01b', 'a1a'])).toEqual(['a1a', 'a01b']);
  });

  test('upper wins on a pure case tie, and case is only ever the tiebreak', () => {
    expect(sortSpecifiers(['post', 'PostView'])).toEqual(['PostView', 'post']);
    expect(sortSpecifiers(['Zeta', 'alpha'])).toEqual(['alpha', 'Zeta']);
  });

  test('a prefix sorts before the longer name', () => {
    expect(sortSpecifiers(['posting', 'post'])).toEqual(['post', 'posting']);
  });

  test('it does not mutate the array it was given', () => {
    const names = ['b', 'a'];
    expect(sortSpecifiers(names)).toEqual(['a', 'b']);
    expect(names).toEqual(['b', 'a']);
  });
});

describe('wrapList', () => {
  test('a list that fits stays on one line', () => {
    expect(wrapList('  ', '[', ['a', 'b'], ']')).toBe('  [a, b]');
    const exact = wrapList('', '[', ['x'.repeat(LINE_WIDTH - 2)], ']');
    expect(exact).toHaveLength(LINE_WIDTH);
    expect(exact).not.toContain('\n');
  });

  test('one character past the width breaks, one entry per line with a trailing comma', () => {
    const entry = 'x'.repeat(LINE_WIDTH - 1);
    expect(wrapList('', '[', [entry], ']')).toBe(`[\n  ${entry},\n]`);
  });
});

describe('wrapImport', () => {
  test('a short import is spaced inside the braces, and sorted', () => {
    expect(wrapImport(['post', 'PostView'], '@app/db')).toBe(
      "import { PostView, post } from '@app/db';",
    );
  });

  test('exactly the line width stays joined; one character more breaks', () => {
    // `import { <name> } from '<from>';` is 20 characters of punctuation plus the two names.
    const fits = wrapImport(['n'.repeat(79)], 'm');
    expect(fits).toHaveLength(LINE_WIDTH);
    expect(fits).not.toContain('\n');
    const breaks = wrapImport(['n'.repeat(80)], 'm');
    expect(breaks.split('\n')[0]).toBe('import {');
  });

  test('a long import breaks without the stray space wrapList would leave', () => {
    const names = ['aLongExportedName', 'anotherLongExportedName', 'aThirdLongExportedName'];
    const rendered = wrapImport(names, '@app/really/quite/a/long/module/specifier');
    expect(rendered.split('\n')[0]).toBe('import {');
    expect(rendered).not.toContain('{ \n');
    expect(rendered.split('\n').at(-1)).toBe("} from '@app/really/quite/a/long/module/specifier';");
    for (const name of names) expect(rendered).toContain(`  ${name},`);
  });
});
