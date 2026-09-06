// The selector grammar `find`/`all` read, driven through `mountIsland` for `island-dom.test.ts`'s
// reason: a test that calls the parser proves the parser matches itself, and an island proves the
// grammar addresses the markup Solid actually renders. The refusals are the one part asked
// directly, because an offset is a fact about the string and not about any tree.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { IslandBuilder } from './fixture-island';
import { mountIsland } from './fixture-island';
import { parseSelector } from './island-selector';
import { testName } from './test-types';

const FILE = 'apps/web/site/tree.island.tsx';
const ROOT = '/tmp/island-selector-root';

const builderOf = (chunks: readonly { file: string; code: string }[]): IslandBuilder => {
  return (root: string) => Promise.resolve({ chunks: root === ROOT ? chunks : [] });
};

/**
 * Rows in a scroller in a panel — the shape of a virtualized list, which is what a one-regex
 * grammar could not address: the buttons a test wants are three levels down and share a tag with
 * the one in the toolbar beside them.
 */
const TREE_ISLAND = `const _tmpl$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<section id="panel" class="panel wide"><div class="toolbar"><button data-role="reload">reload</button></div><div data-role="scroller"><ul class="rows"><li class="row" data-index="0"><span>a</span><button data-role="open">open a</button></li><li class="row odd" data-index="1"><span>b</span><button data-role="open">open b</button></li></ul></div></section>';
  return t.content.firstChild;
})();

export function mount(el) {
  el.textContent = '';
  el.appendChild(document.importNode(_tmpl$, true));
}
`;

const mount = () =>
  mountIsland({ build: builderOf([{ file: FILE, code: TREE_ISLAND }]), root: ROOT, file: FILE });

const texts = (island: { all: (s: string) => readonly { textContent: string }[] }, s: string) =>
  island.all(s).map((each) => each.textContent);

describe(testName('unit', 'the island DOM answers a compound selector with combinators'), () => {
  test('a descendant combinator reaches three levels down and skips the toolbar', async () => {
    using island = await mount();
    expect(texts(island, '[data-role="scroller"] button')).toEqual(['open a', 'open b']);
    expect(texts(island, 'button')).toEqual(['reload', 'open a', 'open b']);
  });

  test('a child combinator matches the parent and NOT the grandparent', async () => {
    using island = await mount();
    // `li` is a child of `ul`, and a grandchild of the scroller: `>` must tell the two apart, or a
    // `<For>` rendering rows in a nested wrapper reads as flat.
    expect(island.all('ul > li')).toHaveLength(2);
    expect(island.all('[data-role="scroller"] > li')).toHaveLength(0);
    expect(island.all('[data-role="scroller"] > ul > li > button')).toHaveLength(2);
  });

  test('a chain of descendants backtracks over ancestors', async () => {
    using island = await mount();
    // `section div span`: the `div` may be the scroller, not the toolbar — a matcher that took the
    // first `div` ancestor and stopped would answer nothing here.
    expect(texts(island, 'section div span')).toEqual(['a', 'b']);
    expect(texts(island, '.toolbar span')).toEqual([]);
  });

  test('tag, #id, .class, [attr] and [attr="value"] compound on one element', async () => {
    using island = await mount();
    expect(island.find('section#panel.panel.wide')).not.toBeNull();
    expect(island.find('section#other')).toBeNull();
    expect(island.find('li.row.odd')?.getAttribute('data-index')).toBe('1');
    expect(island.all('li[data-index]')).toHaveLength(2);
    expect(island.find('li[data-index="1"] > button')?.textContent).toBe('open b');
    expect(island.find("li[data-index='0'] button")?.textContent).toBe('open a');
    expect(island.all('.row')).toHaveLength(2);
    expect(island.find('#panel > .toolbar > button')?.textContent).toBe('reload');
  });

  test('whitespace around > and at the ends is not a descendant', async () => {
    using island = await mount();
    expect(island.all('  ul>li  ')).toHaveLength(2);
    expect(island.all('ul   >   li')).toHaveLength(2);
    expect(island.all('*')).toHaveLength(11);
  });

  test('an ancestor above the queried element still counts, as the DOM counts it', async () => {
    using island = await mount();
    const scroller = island.find('[data-role="scroller"]');
    // `section` is above `scroller`; `scroller.querySelectorAll('section li')` finds the rows in
    // a browser, and this DOM agrees rather than stopping the walk at the call's own element.
    expect(scroller?.querySelectorAll('section li')).toHaveLength(2);
    expect(scroller?.querySelectorAll('[data-role="scroller"]')).toHaveLength(0);
  });
});

describe(
  testName('unit', 'a selector outside the grammar is refused, never silently empty'),
  () => {
    const refusal = (selector: string): UltimateError => {
      let caught: unknown;
      try {
        parseSelector(selector);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UltimateError);
      return caught as UltimateError;
    };

    test.each([
      ['li:first-child', 2],
      ['a, b', 1],
      ['a + b', 2],
      ['a ~ b', 2],
      ['[a]li', 3],
      ['', 0],
      ['   ', 0],
      ['[data-role=unquoted]', 0],
      ['ul >', 4],
    ])('%s is X_TEST_ISLAND_SELECTOR_UNSUPPORTED at offset %i', (selector, at) => {
      const error = refusal(selector);
      expect(error.code).toBe('X_TEST_ISLAND_SELECTOR_UNSUPPORTED');
      expect(error.cause).toContain(`offset ${at}`);
      expect(error.fix).toContain('> (child)');
    });

    test('and the refusal reaches find() through a mounted island', async () => {
      using island = await mount();
      expect(() => island.find('li:nth-child(2)')).toThrow(
        expect.objectContaining({ code: 'X_TEST_ISLAND_SELECTOR_UNSUPPORTED' }),
      );
    });
  },
);
