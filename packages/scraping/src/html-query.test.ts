import { describe, expect, test } from 'bun:test';
import { markupEnabled, markupVisible, queryHtml } from './html-query';

describe('unit · selectors over an HTML string, on Bun natives only', () => {
  test('a void element closes on open — it has no end tag to wait for', async () => {
    const [input] = await queryHtml('<input id="q" name="q" value="v">', '#q');
    expect(input?.tag).toBe('input');
    expect(input?.value).toBe('v');
  });

  test('text is flattened across nested elements', async () => {
    const [link] = await queryHtml('<a href="/x">Two <b>bold</b></a>', 'a');
    expect(link?.text).toBe('Two bold');
    expect(link?.attrs['href']).toBe('/x');
  });

  test('every match is returned, in document order', async () => {
    const rows = await queryHtml('<li class="r">1</li><li class="r">2</li>', '.r');
    expect(rows.map((row) => row.text)).toEqual(['1', '2']);
  });

  test('the document root answers even for a fragment with no <html>', async () => {
    const [root] = await queryHtml('<p>hi</p>', 'html');
    expect(root?.text).toBe('hi');
  });

  test('nothing offline carries a box or a hit-target — there is no layout engine', async () => {
    const [element] = await queryHtml('<button id="b">Go</button>', '#b');
    expect(element?.box).toBeUndefined();
    expect(element?.hitTarget).toBeUndefined();
  });
});

describe('unit · what markup alone can say about visibility', () => {
  test('hidden, display:none, visibility:hidden, aria-hidden and type=hidden', () => {
    expect(markupVisible('div', { hidden: '' })).toBe(false);
    expect(markupVisible('div', { style: 'display: none' })).toBe(false);
    expect(markupVisible('div', { style: 'color: red; visibility:hidden;' })).toBe(false);
    expect(markupVisible('div', { 'aria-hidden': 'true' })).toBe(false);
    expect(markupVisible('input', { type: 'hidden' })).toBe(false);
    expect(markupVisible('div', { style: 'display: block' })).toBe(true);
  });

  test('disabled and aria-disabled', () => {
    expect(markupEnabled({ disabled: '' })).toBe(false);
    expect(markupEnabled({ 'aria-disabled': 'true' })).toBe(false);
    expect(markupEnabled({})).toBe(true);
  });
});
