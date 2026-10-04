// Direct coverage for `xml.ts` — the escaping every sitemap, feed and OpenSearch document in this
// package is built out of. Untested until now despite being the one place an unescaped `&` or a
// `]]>` inside CDATA turns a valid document into one a crawler rejects.

import { describe, expect, test } from 'bun:test';
import { escapeHtml } from '@ultimat3/core';
import { absoluteUrl, attributes, cdata, escapeXml, xmlElement } from './xml';

describe('escapeXml', () => {
  test('escapes all five special characters', () => {
    expect(escapeXml('&')).toBe('&amp;');
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('>')).toBe('&gt;');
    expect(escapeXml('"')).toBe('&quot;');
    // `&#39;`, a numeric reference: the same output is well-formed XML and valid HTML.
    expect(escapeXml("'")).toBe('&#39;');
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
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;',
    );
  });

  test('all five special characters in sequence encode in order', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  test("is core's character table, so seo and every HTML writer escape one set", () => {
    const value = `it's "quoted" & <tagged>`;
    expect(escapeXml(value)).toBe(escapeHtml(value));
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

  test('an attribute drops it too, so an attribute cannot break the document either', () => {
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

describe('xmlElement', () => {
  test('wraps text in <name>...</name>', () => {
    expect(xmlElement('title', 'hello')).toBe('<title>hello</title>');
  });

  test('escapes the text via escapeXml, not just wraps it', () => {
    expect(xmlElement('title', 'Fish & Chips <best>')).toBe(
      '<title>Fish &amp; Chips &lt;best&gt;</title>',
    );
  });

  test('apostrophes are escaped in element text too', () => {
    expect(xmlElement('title', "cook's tour")).toBe('<title>cook&#39;s tour</title>');
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

  test('values are escaped with the one table: apostrophes and quotes both', () => {
    expect(attributes({ title: `it's "quoted"` })).toBe(` title="it&#39;s &quot;quoted&quot;"`);
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
