// A head tag attribute is validated by name and answers to `attributePair`, a drop warned in dev.
// Split out of `head.test.ts` at the file ceiling.

import { describe, expect, test } from 'bun:test';
import { setLogSink } from '@ultimat3/core';
import { documentBaseline, type HeadTag, renderHead } from './head';

/**
 * The second attribute sink in this package. `attributePair` validates the NAME it is handed —
 * a name is emitted verbatim before the `=` and is escaped nowhere, so a key carrying a space
 * carries a whole second attribute with it — and `renderTag` interpolated `attrs` keys raw. Reach
 * here is an app spreading a row into a head tag's `attrs`, which is narrower than JSX spread and
 * is the same status every other author-controlled sink in this file already defends against.
 */
describe('a head tag attribute name is validated, not just its value', () => {
  test('a key that would open a second attribute emits nothing', () => {
    const html = renderHead([
      {
        kind: 'meta',
        key: 'meta:x',
        attrs: { name: 'x', 'y onmouseover=alert(1) z': 'ok', 'a b': true },
      },
    ]);
    expect(html).toBe('<meta name="x">');
  });

  test('every name a real head tag writes still renders', () => {
    const html = renderHead([
      {
        kind: 'link',
        key: 'link:x',
        attrs: { rel: 'alternate', hreflang: 'en-GB', 'data-x': '1', 'xlink:href': '/a' },
      },
    ]);
    expect(html).toBe('<link rel="alternate" hreflang="en-GB" data-x="1" xlink:href="/a">');
  });
});

/**
 * `attributePair` is the package's one attribute rule. `renderTag` borrowed its name predicate and
 * wrote the rest again, so a row spread into `attrs` printed what the JSX path refuses one file over.
 */
describe('a head tag attribute answers to attributePair', () => {
  const link = (attrs: NonNullable<HeadTag['attrs']>): string =>
    renderHead([{ kind: 'link', key: 'link:x', attrs: { rel: 'preload', ...attrs } }]);

  test.each(['onload', 'ONLOAD', 'onError'])('the event handler %s is absent', (name) => {
    expect(link({ [name]: 'alert(1)' })).toBe('<link rel="preload">');
  });

  test.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'vbscript:x'])(
    'the href %j is absent',
    (href) => {
      expect(link({ href })).toBe('<link rel="preload">');
    },
  );

  test('the folded spelling of a url attribute is screened too', () => {
    expect(link({ HREF: 'javascript:alert(1)' })).toBe('<link rel="preload">');
  });

  test('a script src takes the same screen', () => {
    const tag: HeadTag = { kind: 'script', key: 'script:x', attrs: { src: 'javascript:alert(1)' } };
    expect(renderHead([tag])).toBe('<script></script>');
  });

  test('a base href takes the same screen', () => {
    const tag: HeadTag = { kind: 'base', key: 'base', attrs: { href: 'javascript:alert(1)//' } };
    expect(renderHead([tag])).toBe('<base>');
  });

  test('srcdoc, entity-decoded and parsed as html, is absent', () => {
    expect(link({ srcdoc: '<script>alert(1)</script>' })).toBe('<link rel="preload">');
  });

  // `async="false"` is an async script: the attribute's presence is the whole of its meaning.
  test('false emits nothing rather than the word', () => {
    const tag: HeadTag = { kind: 'script', key: 'script:x', attrs: { async: false, src: '/a.js' } };
    expect(renderHead([tag])).toBe('<script src="/a.js"></script>');
  });

  test('content, rel, a boolean and a real url are unchanged', () => {
    expect(
      renderHead([
        { kind: 'meta', key: 'meta:a', attrs: { name: 'a', content: 'javascript:is text here' } },
        {
          kind: 'link',
          key: 'link:a',
          attrs: { rel: 'canonical', href: 'https://x.test/a?b=1&c' },
        },
        { kind: 'link', key: 'link:b', attrs: { rel: 'preconnect', href: '//cdn.x.test' } },
        { kind: 'script', key: 'script:a', attrs: { src: '/a.js', async: true } },
      ]),
    ).toBe(
      '<meta name="a" content="javascript:is text here">' +
        '<link rel="canonical" href="https://x.test/a?b=1&amp;c">' +
        '<link rel="preconnect" href="//cdn.x.test">' +
        '<script src="/a.js" async></script>',
    );
  });

  // A link's href is fetched or read as metadata, never navigated, so the exemption `safeUrl` gives
  // a rendered `src` holds here. Real usage: an inline favicon.
  test.each(['data:image/png;base64,AAA', 'DATA:image/webp;base64,AAA', 'data:image/x-icon,AA'])(
    'the link href %s prints',
    (href) => {
      expect(link({ rel: 'icon', href })).toBe(`<link rel="icon" href="${href}">`);
    },
  );

  // SVG is a script document, and nothing but an image is carved out.
  test.each(['data:image/svg+xml,<svg/>', 'data:text/html,x', 'blob:https://x.test/1'])(
    'the link href %s stays absent',
    (href) => {
      expect(link({ rel: 'icon', href })).toBe('<link rel="icon">');
    },
  );

  test('the data exemption is the link element only', () => {
    const tag: HeadTag = { kind: 'base', key: 'base', attrs: { href: 'data:image/png,AA' } };
    expect(renderHead([tag])).toBe('<base>');
  });

  // A declared app deep link: `alternate` is read by a crawler, never fetched or followed.
  test.each(['android-app://com.x/https/x.test/a', 'ios-app://123/https/x.test/a'])(
    'rel=alternate keeps the app link %s',
    (href) => {
      expect(link({ rel: 'alternate', href })).toBe(`<link rel="alternate" href="${href}">`);
    },
  );

  test.each([
    ['canonical', 'android-app://com.x/a'],
    ['icon', 'ios-app://123/a'],
    ['alternate stylesheet', 'android-app://com.x/a'],
    ['alternate', 'java\tandroid-app://x'],
    ['alternate', 'javascript:alert(1)'],
  ])('rel=%s drops the href %j', (rel, href) => {
    expect(link({ rel, href })).toBe(`<link rel="${rel}">`);
  });

  describe('a drop warns in dev, naming the tag and the attribute, never the value', () => {
    const logged = (run: () => void): string => {
      const lines: string[] = [];
      const previous = setLogSink((line) => {
        lines.push(line);
      });
      try {
        run();
      } finally {
        setLogSink(previous);
      }
      return lines.join('\n');
    };
    const dropping = (key: string): HeadTag => ({
      kind: 'link',
      key,
      attrs: { rel: 'icon', href: 'javascript:secret-value', async: false },
    });

    test('one line per tag and attribute, however many renders', () => {
      const lines = logged(() => {
        renderHead([dropping('link:warned')]);
        renderHead([dropping('link:warned')]);
      });
      expect(lines.match(/head\.attribute_dropped/g)).toHaveLength(1);
      expect(lines).toContain('link:warned');
      expect(lines).toContain('href');
      expect(lines).not.toContain('secret-value');
      expect(lines).not.toContain('async');
    });

    test('a production render says nothing', () => {
      const previous = process.env['ULTIMATE_ENV'];
      process.env['ULTIMATE_ENV'] = 'production';
      try {
        expect(logged(() => renderHead([dropping('link:production')]))).toBe('');
      } finally {
        if (previous === undefined) delete process.env['ULTIMATE_ENV'];
        else process.env['ULTIMATE_ENV'] = previous;
      }
    });
  });

  test('every framework head tag prints as it did', () => {
    expect(renderHead(documentBaseline())).toBe(
      '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta name="color-scheme" content="light dark">',
    );
  });
});
