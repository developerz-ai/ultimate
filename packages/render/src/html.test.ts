import { describe, expect, test } from 'bun:test';
import { escapeAttribute as seoEscapeAttribute } from '@ultimat3/seo';
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

  // Identity, not equivalence: two functions that agree today are exactly how one of them ends up
  // missing a character. `@ultimat3/seo` owns the one attribute escaper and this package re-exports
  // it, so re-introducing a local copy fails here rather than in a pentest.
  test("the attribute escaper is seo's own function, never a second copy", () => {
    expect(escapeAttribute).toBe(seoEscapeAttribute);
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

/**
 * The escaper makes a value inert INSIDE an attribute; it cannot make a scheme inert, because
 * `href="javascript:alert(1)"` needs no quote to break out of. This module declares itself the one
 * place injection is prevented, so the scheme check belongs at the same choke point — `href` off a
 * database row is the shape every app writes.
 */
describe('attributePair refuses a dangerous URL scheme', () => {
  test('javascript: is dropped rather than emitted, in every URL-bearing attribute', () => {
    expect(attributePair('href', 'javascript:alert(1)')).toBeNull();
    expect(attributePair('src', 'javascript:alert(1)')).toBeNull();
    expect(attributePair('action', 'javascript:alert(1)')).toBeNull();
    expect(attributePair('formAction', 'javascript:alert(1)')).toBeNull();
    expect(attributePair('formaction', 'javascript:alert(1)')).toBeNull();
  });

  test('a control character a browser strips cannot smuggle the scheme past the check', () => {
    expect(attributePair('href', 'java\tscript:alert(1)')).toBeNull();
  });

  test('an ordinary link, a relative path and a data:image src are untouched', () => {
    expect(attributePair('href', '/posts/1')).toBe('href="/posts/1"');
    expect(attributePair('href', 'https://ultimate.dev')).toBe('href="https://ultimate.dev"');
    expect(attributePair('src', 'data:image/webp;base64,AAA')).toBe(
      'src="data:image/webp;base64,AAA"',
    );
  });

  test('the guard is scoped to URL attributes — a colon in ordinary text still renders', () => {
    expect(attributePair('title', 'javascript:alert(1)')).toBe('title="javascript:alert(1)"');
  });

  test('a refused href is absent from the rendered attribute list, not blanked', () => {
    expect(renderAttributes({ href: 'javascript:alert(1)', id: 'a' })).toBe(' id="a"');
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

/**
 * `<div {...row} />` where `row` is a `load()` result or a DB row: a column named for a member of
 * `Object.prototype` is a plain string on the object and must render as a plain attribute. The
 * alias lookup used to walk the prototype chain, so `toString` resolved to a FUNCTION and the
 * next line called `.toLowerCase()` on it — a TypeError with no code, and the whole page 500s.
 */
describe('attributePair with a prop named after an Object.prototype member', () => {
  const inherited = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

  test('renders the name it was given, never a function off the prototype', () => {
    for (const name of inherited) {
      expect(attributePair(name, 'x')).toBe(`${name}="x"`);
    }
  });

  test('a spread row carrying one still renders every other attribute', () => {
    expect(renderAttributes({ title: 'Hello', toString: 'x' })).toBe(' title="Hello" toString="x"');
  });

  test('the real aliases still map, so the lookup was narrowed and not removed', () => {
    expect(attributePair('className', 'a')).toBe('class="a"');
    expect(attributePair('htmlFor', 'a')).toBe('for="a"');
  });
});

/**
 * The scheme choke point covers every attribute a browser FOLLOWS, not just the four an anchor
 * uses — and `srcdoc` is not a URL at all: its value is entity-decoded and then parsed as HTML, so
 * escaping it ships a live `<script>` inside an iframe on this origin.
 */
describe('attributePair beyond href/src', () => {
  test('refuses javascript: in every attribute a browser follows', () => {
    for (const name of ['data', 'poster', 'ping', 'xlink:href', 'XLink:Href']) {
      expect(attributePair(name, 'javascript:alert(1)')).toBeNull();
    }
  });

  test('leaves an ordinary value in those attributes alone', () => {
    expect(attributePair('poster', '/cover.webp')).toBe('poster="/cover.webp"');
    expect(attributePair('data', 'https://ultimate.dev/x.pdf')).toBe(
      'data="https://ultimate.dev/x.pdf"',
    );
  });

  test('srcdoc is never emitted, because escaping cannot make markup inert there', () => {
    expect(attributePair('srcdoc', '<script>alert(1)</script>')).toBeNull();
    expect(attributePair('srcdoc', 'plain text')).toBeNull();
    expect(renderAttributes({ srcdoc: '<script>alert(1)</script>', title: 'a' })).toBe(
      ' title="a"',
    );
  });
});

/**
 * Two holes in one line. The prefix test was case-SENSITIVE while the two checks under it fold
 * case, so `ONERROR` was emitted verbatim; and the attribute NAME was never validated at all, so a
 * key containing a space carried a second attribute out of the quotes. Both are reachable by
 * `<div {...row} />` over attacker-chosen keys — a JSON body, a JSONB column, a query string.
 */
describe('attributePair refuses an event handler in any casing', () => {
  const handlers = ['onclick', 'ONCLICK', 'OnClick', 'ONERROR', 'onError', 'ONMOUSEOVER'];

  test('every casing of a handler name emits nothing', () => {
    for (const name of handlers) {
      expect(attributePair(name, 'alert(1)')).toBeNull();
    }
  });

  test('a spread row carrying one renders every other attribute and none of it', () => {
    expect(renderAttributes({ ONERROR: 'alert(1)', id: 'a' })).toBe(' id="a"');
  });

  test('`on` alone and `On` are still real attribute names, not handler prefixes', () => {
    expect(attributePair('on', 'x')).toBe('on="x"');
    expect(attributePair('On', 'x')).toBe('On="x"');
  });
});

describe('attributePair refuses a name that is not an attribute name', () => {
  const injected = [
    'x onmouseover=alert(1) y',
    'a b=c',
    'id="x" onload="alert(1)',
    'a>b',
    'a\tb',
    'a\nb',
    '',
    '1abc',
    'a="b"',
  ];

  test('a key that would carry a second attribute out of the quotes emits nothing', () => {
    for (const name of injected) {
      expect(attributePair(name, 'ok')).toBeNull();
    }
  });

  test('a spread row carrying one renders every other attribute and none of it', () => {
    expect(renderAttributes({ 'x onmouseover=alert(1) y': 'ok', id: 'a' })).toBe(' id="a"');
  });

  test('the names an app really writes still render', () => {
    for (const name of ['data-x-id', 'aria-label', 'xlink:href', '_x', 'x.y', 'toString']) {
      expect(attributePair(name, 'ok')).toBe(`${name}="ok"`);
    }
  });
});
