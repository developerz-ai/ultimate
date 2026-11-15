// The offline drivers' accessibility read: the HTML-AAM mapping, every source of a name in accname
// order, and the two answers that make the read worth having — a `<div onclick>` with no role and
// no name, and a hidden node pruned rather than described.

import { describe, expect, test } from 'bun:test';
import { htmlAccessibility } from './html-a11y';

const read = (html: string, selector: string, max = 25) => htmlAccessibility(html, selector, max);

describe('unit · role', () => {
  test('implicit roles from the tag, and an explicit role wins', async () => {
    const html = `<a id="l" href="/x">Next</a><a id="anchor">no href</a>
      <input id="t"><input id="c" type="checkbox"><input id="s" type="submit">
      <select id="one"></select><select id="many" multiple></select>
      <h2 id="h">Orders</h2><div id="d" role="button tab">Act</div><div id="plain">x</div>`;
    const roles = async (selector: string) => (await read(html, selector))[0]?.role;
    expect(await roles('#l')).toBe('link');
    expect(await roles('#anchor')).toBe('');
    expect(await roles('#t')).toBe('textbox');
    expect(await roles('#c')).toBe('checkbox');
    expect(await roles('#s')).toBe('button');
    expect(await roles('#one')).toBe('combobox');
    expect(await roles('#many')).toBe('listbox');
    expect(await roles('#h')).toBe('heading');
    expect(await roles('#d')).toBe('button');
    expect(await roles('#plain')).toBe('');
  });

  test('a <div onclick> maps to no role and no name — the finding, not an invented button', async () => {
    expect(await read('<div id="f" onclick="go()">Looks clickable</div>', '#f')).toEqual([
      { role: '', name: '', ignored: false },
    ]);
  });
});

describe('unit · name, in accname order', () => {
  test('aria-labelledby, then aria-label, then the label, then content', async () => {
    const html = `<span id="a">Billing</span><span id="b">address</span>
      <input id="by" aria-labelledby="a b" aria-label="ignored">
      <button id="al" aria-label="Run search">Go</button>
      <label for="q">Search orders</label><input id="q">
      <button id="content">  Save   draft </button>`;
    const name = async (selector: string) => (await read(html, selector))[0]?.name;
    expect(await name('#by')).toBe('Billing address');
    expect(await name('#al')).toBe('Run search');
    expect(await name('#q')).toBe('Search orders');
    expect(await name('#content')).toBe('Save draft');
  });

  test('alt, a submit default, title, and placeholder last', async () => {
    const html = `<img id="i" src="a.png" alt="Logo"><input id="s" type="submit">
      <input id="t" title="Coupon" placeholder="ignored"><input id="p" placeholder="Search">
      <p id="para">Not a name source</p>`;
    const name = async (selector: string) => (await read(html, selector))[0]?.name;
    expect(await name('#i')).toBe('Logo');
    expect(await name('#s')).toBe('Submit');
    expect(await name('#t')).toBe('Coupon');
    expect(await name('#p')).toBe('Search');
    expect(await name('#para')).toBe('');
  });
});

describe('unit · names from ancestors and descendants', () => {
  test('a control wrapped in its <label>, and a link whose content is an <img alt>', async () => {
    const html = '<label>Email <input id="e" type="email"></label><a href="/"><img alt="Home"></a>';
    expect(await read(html, 'input,a', 10)).toEqual([
      { role: 'textbox', name: 'Email', ignored: false },
      { role: 'link', name: 'Home', ignored: false },
    ]);
  });

  test('a <label for> still wins over the label the control sits in', async () => {
    const html = '<label for="q">Search</label><label>Outer <input id="q"></label>';
    expect((await read(html, '#q'))[0]?.name).toBe('Search');
  });
});

describe('unit · state and bounds', () => {
  test('a hidden node is ignored with nothing computed; a disabled control says so', async () => {
    const html = `<button id="h" aria-hidden="true">Hidden</button><button id="d" disabled>Off</button>`;
    expect(await read(html, '#h')).toEqual([{ role: '', name: '', ignored: true }]);
    expect(await read(html, '#d')).toEqual([
      { role: 'button', name: 'Off', disabled: true, ignored: false },
    ]);
  });

  test('at most max nodes, in document order', async () => {
    const nodes = await read('<li>a</li><li>b</li><li>c</li>', 'li', 2);
    expect(nodes.map((node) => node.role)).toEqual(['listitem', 'listitem']);
  });
});
