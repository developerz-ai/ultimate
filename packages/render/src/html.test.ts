import { describe, expect, test } from 'bun:test';
import { attributePair, escapeAttribute, escapeText, renderAttributes, styleValue } from './html';

describe('escaping', () => {
  test('text escapes the three characters that can open a tag', () => {
    expect(escapeText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  test('escapes the ampersand first, so an entity is not double-encoded into nonsense', () => {
    expect(escapeText('<')).toBe('&lt;');
  });

  test('an attribute additionally escapes the quote that would close it', () => {
    expect(escapeAttribute('" onload="alert(1)')).toBe('&quot; onload=&quot;alert(1)');
  });
});

describe('attributePair', () => {
  test('drops props the tree consumes rather than emits', () => {
    for (const name of ['children', 'ref', 'key', 'innerHTML', 'textContent']) {
      expect(attributePair(name, 'x')).toBeNull();
    }
  });

  test('drops absent values, so `class={undefined}` emits no attribute', () => {
    expect(attributePair('class', undefined)).toBeNull();
    expect(attributePair('class', null)).toBeNull();
    expect(attributePair('disabled', false)).toBeNull();
  });

  test('true is a bare attribute', () => {
    expect(attributePair('disabled', true)).toBe('disabled');
  });

  test('an event handler never reaches the wire', () => {
    expect(attributePair('onClick', () => undefined)).toBeNull();
    expect(attributePair('onclick', 'alert(1)')).toBeNull();
    // `on` alone is a real (if unusual) attribute name, not a handler prefix.
    expect(attributePair('on', 'x')).toBe('on="x"');
  });

  test('the React spellings compile to the HTML ones', () => {
    expect(attributePair('className', 'a')).toBe('class="a"');
    expect(attributePair('htmlFor', 'a')).toBe('for="a"');
  });

  test('a number is stringified, not dropped', () => {
    expect(attributePair('tabindex', 0)).toBe('tabindex="0"');
  });
});

describe('styleValue', () => {
  test('camelCase becomes the CSS property', () => {
    expect(styleValue({ marginTop: '1rem', color: 'red' })).toBe('margin-top:1rem;color:red');
  });

  test('a custom property keeps its dashes', () => {
    expect(styleValue({ '--x': '1' })).toBe('--x:1');
  });

  test('a string passes through and an empty object emits nothing', () => {
    expect(styleValue('color:red')).toBe('color:red');
    expect(styleValue({})).toBeNull();
  });
});

describe('renderAttributes', () => {
  test('leads with a space only when something is emitted', () => {
    expect(renderAttributes({})).toBe('');
    expect(renderAttributes({ children: 'x' })).toBe('');
    expect(renderAttributes({ id: 'a', class: 'b' })).toBe(' id="a" class="b"');
  });
});
