// `parseHtml` reads what `babel-preset-solid` emits: the `<!>` marker Solid walks past with
// `nextSibling`, and text and attributes carrying the five entities its escaper writes.

import { describe, expect, test } from 'bun:test';
import { FakeElement, type FakeText, parseHtml } from './island-dom';
import { decodeEntities } from './island-html-entities';
import { testName } from './test-types';

describe(testName('unit', 'parseHtml builds the tree a browser builds'), () => {
  test('a <!> marker is one empty node between its siblings, as a browser comment is', () => {
    const [div] = parseHtml('<div>a<!>b</div>').childNodes;
    expect(div).toBeInstanceOf(FakeElement);
    const nodes = (div as FakeElement).childNodes;
    expect(nodes).toHaveLength(3);
    expect(nodes.map((node) => (node as FakeText).data)).toEqual(['a', '', 'b']);
    expect((div as FakeElement).textContent).toBe('ab');
  });

  test('a marker between elements keeps the nextSibling walk Solid compiles', () => {
    const [div] = parseHtml('<div><span>x</span><!><b>y</b></div>').childNodes;
    const [, marker, b] = (div as FakeElement).childNodes;
    expect((div as FakeElement).firstChild?.nextSibling).toBe(marker as FakeText);
    expect((marker as FakeText).data).toBe('');
    expect(marker?.nextSibling).toBe(b as FakeElement);
    expect((b as FakeElement).tagName).toBe('b');
  });

  test('a full comment is a marker too, never text, even holding a >', () => {
    const [p] = parseHtml('<p>a<!-- x > y -->b</p>').childNodes;
    expect((p as FakeElement).childNodes).toHaveLength(3);
    expect((p as FakeElement).textContent).toBe('ab');
  });

  test('the five entities are decoded in text', () => {
    const [p] = parseHtml('<p>&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39;</p>').childNodes;
    expect((p as FakeElement).textContent).toBe(`<a> & "b" 'c'`);
  });

  test('the five entities are decoded in an attribute value, every quoting', () => {
    const [a] = parseHtml(`<a title="&quot;x&quot; &amp; y" data-q='&#39;' data-u=&lt;>t</a>`)
      .childNodes as FakeElement[];
    expect(a?.getAttribute('title')).toBe('"x" & y');
    expect(a?.getAttribute('data-q')).toBe("'");
    expect(a?.getAttribute('data-u')).toBe('<');
  });
});

describe(testName('unit', 'decodeEntities'), () => {
  test('decodes once: an escaped entity stays an entity', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  test('&apos; and numeric references, decimal and hex', () => {
    expect(decodeEntities('&apos;&#65;&#x42;')).toBe("'AB");
  });

  test('an unknown name is left as written', () => {
    expect(decodeEntities('&nbsp; & alone')).toBe('&nbsp; & alone');
  });

  test('zero, a surrogate and an out-of-range code point are U+FFFD, as a browser parses them', () => {
    expect(decodeEntities('&#0;|&#xD800;|&#xdfff;|&#x110000;|&#99999999999;')).toBe(
      '\uFFFD|\uFFFD|\uFFFD|\uFFFD|\uFFFD',
    );
  });
});
