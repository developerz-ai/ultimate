// Direct coverage for `xml.ts` — the escaping every sitemap, feed and OpenSearch document in this
// package is built out of. Untested until now despite being the one place an unescaped `&` or a
// `]]>` inside CDATA turns a valid document into one a crawler rejects.

import { describe, expect, test } from 'bun:test';
import { absoluteUrl, attributes, cdata, escapeAttribute, escapeXml, xmlElement } from './xml';

describe('escapeXml', () => {
  test('escapes all five special characters', () => {
    expect(escapeXml('&')).toBe('&amp;');
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('>')).toBe('&gt;');
    expect(escapeXml('"')).toBe('&quot;');
    expect(escapeXml("'")).toBe('&apos;');
  });

  test('leaves other characters untouched', () => {
    expect(escapeXml('hello world 123')).toBe('hello world 123');
  });

  test('a string with no special chars is returned unchanged', () => {
    const value = 'no special characters here';
    expect(escapeXml(value)).toBe(value);
  });

  test('encodes each special character independently, no double-escaping', () => {
    // if `&` were escaped first and the result re-scanned, the `&` inside `&amp;` would be
    // re-escaped into `&amp;amp;` — assert the exact one-pass output instead.
    expect(escapeXml('<script>alert("x")&\'y\'</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&apos;y&apos;&lt;/script&gt;',
    );
  });

  test('all five special characters in sequence encode in order', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

// XML 1.0 has no way to write these AT ALL — not raw, and not as `&#1;`, which is illegal too
// (`Char` excludes them, and a numeric reference is a `Char`). So the only thing an emitter can do
// with one is drop it. One byte of a scraped title, a paste out of a Word document or a `\x00` a
// database column happily stored makes the WHOLE feed not well-formed, and a feed reader answers
// that with "invalid XML" rather than with the item it could not parse.
describe('a character XML 1.0 cannot represent', () => {
  const CONTROL = String.fromCharCode(1);
  const NUL = String.fromCharCode(0);

  test('escapeXml drops it instead of emitting it verbatim', () => {
    expect(escapeXml(`a${CONTROL}b`)).toBe('ab');
    expect(escapeXml(`a${NUL}b`)).toBe('ab');
    // The three C0 characters XML 1.0 DOES allow are not touched: a description holds newlines.
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    // The two non-characters at the end of the BMP are illegal for the same reason.
    const nonCharacters = `a${String.fromCharCode(0xfffe)}b${String.fromCharCode(0xffff)}c`;
    expect(escapeXml(nonCharacters)).toBe('abc');
    // A character above the BMP is a surrogate PAIR and perfectly legal — dropping half of one
    // would be worse than the byte this rule exists for.
    expect(escapeXml('a👍b')).toBe('a👍b');
  });

  test('escapeAttribute drops it too, so an attribute cannot break the document either', () => {
    expect(escapeAttribute(`a${CONTROL}b`)).toBe('ab');
    expect(attributes({ href: `x${NUL}y` })).toBe(' href="xy"');
  });

  test('xmlElement inherits it, which is what a <title> is built out of', () => {
    expect(xmlElement('title', `Q${CONTROL}1 results`)).toBe('<title>Q1 results</title>');
  });

  test('cdata inherits it as well — CDATA suspends markup, never the character rule', () => {
    expect(cdata(`<p>a${CONTROL}b</p>`)).toBe('<![CDATA[<p>ab</p>]]>');
    // And the escape it already had is untouched.
    expect(cdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>');
  });
});

describe('escapeAttribute', () => {
  test('escapes & < > " but not the apostrophe', () => {
    expect(escapeAttribute('&')).toBe('&amp;');
    expect(escapeAttribute('<')).toBe('&lt;');
    expect(escapeAttribute('>')).toBe('&gt;');
    expect(escapeAttribute('"')).toBe('&quot;');
    expect(escapeAttribute("'")).toBe("'");
  });

  test('asymmetry vs escapeXml: apostrophes survive escapeAttribute but not escapeXml', () => {
    const value = `it's "quoted" & <tagged>`;
    expect(escapeAttribute(value)).toBe(`it's &quot;quoted&quot; &amp; &lt;tagged&gt;`);
    expect(escapeXml(value)).toBe(`it&apos;s &quot;quoted&quot; &amp; &lt;tagged&gt;`);
  });
});

describe('xmlElement', () => {
  test('wraps text in <name>...</name>', () => {
    expect(xmlElement('title', 'hello')).toBe('<title>hello</title>');
  });

  test('escapes the text via escapeXml, not just wraps it', () => {
    expect(xmlElement('title', 'Fish & Chips <best>')).toBe(
      '<title>Fish &amp; Chips &lt;best&gt;</title>',
    );
  });

  test('uses escapeXml specifically, not escapeAttribute — apostrophes are also escaped', () => {
    // escapeAttribute deliberately leaves `'` alone; xmlElement must not use it, since element
    // text (unlike an attribute value) is never apostrophe-safe without escaping.
    expect(xmlElement('title', "cook's tour")).toBe('<title>cook&apos;s tour</title>');
  });
});

describe('cdata', () => {
  test('wraps a value in <![CDATA[...]]>', () => {
    expect(cdata('hello world')).toBe('<![CDATA[hello world]]>');
  });

  test('splits a literal ]]> terminator so it cannot prematurely close the section', () => {
    expect(cdata(']]>')).toBe('<![CDATA[]]]]><![CDATA[>]]>');
  });

  test('splits a ]]> terminator embedded within surrounding content', () => {
    const value = 'before]]>after';
    const result = cdata(value);
    expect(result).toBe('<![CDATA[before]]]]><![CDATA[>after]]>');
    // the section is well-formed: it opens exactly once and, per the standard splitting
    // technique, the embedded `]]>` only ever appears immediately followed by a fresh
    // `<![CDATA[` reopening — never left dangling as a premature, unpaired closer.
    expect(result.startsWith('<![CDATA[')).toBe(true);
    expect(result.endsWith(']]>')).toBe(true);
    const reopens = result.split(']]>').length - 1;
    const opens = result.split('<![CDATA[').length - 1;
    expect(reopens).toBe(opens);
  });

  test('splits multiple occurrences of the terminator', () => {
    const value = 'a]]>b]]>c';
    const result = cdata(value);
    expect(result).toBe('<![CDATA[a]]]]><![CDATA[>b]]]]><![CDATA[>c]]>');
  });
});

describe('attributes', () => {
  test('an empty object renders as an empty string', () => {
    expect(attributes({})).toBe('');
  });

  test('multiple entries render space-prefixed and joined, in insertion order', () => {
    expect(attributes({ href: '/a', title: 'A' })).toBe(' href="/a" title="A"');
  });

  test('values are escaped via escapeAttribute: apostrophes survive, quotes do not', () => {
    expect(attributes({ title: `it's "quoted"` })).toBe(` title="it's &quot;quoted&quot;"`);
  });
});

describe('absoluteUrl', () => {
  test('an http:// path is returned verbatim, ignoring baseUrl', () => {
    expect(absoluteUrl('https://example.com', 'http://other.com/x')).toBe('http://other.com/x');
  });

  test('an https:// path is returned verbatim, ignoring baseUrl', () => {
    expect(absoluteUrl('https://example.com', 'https://other.com/x')).toBe('https://other.com/x');
  });

  test('a non-http(s) absolute-looking path is NOT treated as passthrough', () => {
    expect(absoluteUrl('https://example.com', 'ftp://x')).toBe('https://example.com/ftp://x');
  });

  test('joins base and path with exactly one slash: neither has a slash', () => {
    expect(absoluteUrl('https://example.com', 'about')).toBe('https://example.com/about');
  });

  test('joins base and path with exactly one slash: base has a trailing slash', () => {
    expect(absoluteUrl('https://example.com/', 'about')).toBe('https://example.com/about');
  });

  test('joins base and path with exactly one slash: path has a leading slash', () => {
    expect(absoluteUrl('https://example.com', '/about')).toBe('https://example.com/about');
  });

  test('joins base and path with exactly one slash: both have a slash', () => {
    expect(absoluteUrl('https://example.com/', '/about')).toBe('https://example.com/about');
  });

  test('multiple internal slashes on the path collapse to one join point', () => {
    expect(absoluteUrl('https://example.com', '//foo')).toBe('https://example.com/foo');
  });

  // `/blog/` and `/blog` are different resources. This builds every `<loc>` and every canonical,
  // so stripping the slash the author wrote made a trailing-slash site publish URLs that redirect
  // — and made `assertCanonical` compare a canonical against a path it had just rewritten.
  test('a trailing slash the path declares is kept', () => {
    expect(absoluteUrl('https://example.com', 'about/')).toBe('https://example.com/about/');
    expect(absoluteUrl('https://example.com/', '/blog/')).toBe('https://example.com/blog/');
    expect(absoluteUrl('https://example.com', '/blog')).toBe('https://example.com/blog');
  });

  test('only the bare-root join collapses back to the base', () => {
    expect(absoluteUrl('https://example.com', '')).toBe('https://example.com');
    expect(absoluteUrl('https://example.com/', '/')).toBe('https://example.com');
  });
});
