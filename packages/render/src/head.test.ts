// Exercises `head.ts` in isolation from `@ultimat3/seo`: fake `HeadRenderers` stand in for the
// real catalog binding (covered separately by `head-seo.test.ts`), so this file pins the
// merge/dedupe order, the tag renderer's escaping rules, and the inlined theme script's guard.

import { describe, expect, test } from 'bun:test';
import type { RouteMeta } from '@ultimat3/seo';
import { BudgetExceededError } from './errors';
import {
  documentBaseline,
  type HeadRenderers,
  type HeadTag,
  headFromMeta,
  mergeHead,
  renderHead,
  THEME_SCRIPT_MAX_BYTES,
  themeScript,
} from './head';

describe('mergeHead', () => {
  test('a later source wins over an earlier one sharing a key', () => {
    const first: HeadTag[] = [{ kind: 'title', key: 'title', content: 'First' }];
    const second: HeadTag[] = [{ kind: 'title', key: 'title', content: 'Second' }];
    const merged = mergeHead(first, second);
    expect(merged).toEqual([{ kind: 'title', key: 'title', content: 'Second' }]);
  });

  test('output is ordered by kind, then by first-seen position within a kind', () => {
    const sourceA: HeadTag[] = [
      { kind: 'script', key: 'script:a', content: 'a' },
      { kind: 'title', key: 'title', content: 'T' },
    ];
    const sourceB: HeadTag[] = [
      { kind: 'meta', key: 'meta:desc', content: 'd' },
      { kind: 'base', key: 'base', attrs: { href: '/' } },
      { kind: 'script', key: 'script:b', content: 'b' },
    ];
    const merged = mergeHead(sourceA, sourceB);
    expect(merged.map((tag) => tag.key)).toEqual([
      'base',
      'title',
      'meta:desc',
      'script:a',
      'script:b',
    ]);
  });

  test('disjoint keys across sources all survive', () => {
    const merged = mergeHead(
      [{ kind: 'meta', key: 'meta:a', content: 'a' }],
      [{ kind: 'meta', key: 'meta:b', content: 'b' }],
    );
    expect(merged.map((tag) => tag.key).sort()).toEqual(['meta:a', 'meta:b']);
  });

  test('no sources, or all-empty sources, produce an empty array', () => {
    expect(mergeHead()).toEqual([]);
    expect(mergeHead([], [])).toEqual([]);
  });
});

describe('headFromMeta', () => {
  const meta = { title: 'Home' } as RouteMeta;
  const BASELINE = new Set(documentBaseline().map((tag) => tag.key));
  /** Every document carries the baseline; these tests are about what the ROUTE contributes. */
  const routeTags = (tags: readonly HeadTag[]) => tags.filter((tag) => !BASELINE.has(tag.key));

  test('includes the tags from renderers.renderMeta', () => {
    const renderers: HeadRenderers = {
      renderMeta: () => [{ kind: 'title', key: 'title', content: 'Home' }],
    };
    const tags = headFromMeta(meta, renderers);
    expect(routeTags(tags)).toEqual([{ kind: 'title', key: 'title', content: 'Home' }]);
  });

  test('adds one ld+json script tag when renderLd returns a non-null string', () => {
    const renderers: HeadRenderers = {
      renderMeta: () => [],
      renderLd: () => '{"@type":"WebSite"}',
    };
    const tags = headFromMeta(meta, renderers);
    expect(routeTags(tags)).toEqual([
      {
        kind: 'script',
        key: 'script:ld+json',
        attrs: { type: 'application/ld+json' },
        content: '{"@type":"WebSite"}',
      },
    ]);
  });

  test('adds no ld+json tag when renderLd returns null', () => {
    const renderers: HeadRenderers = {
      renderMeta: () => [],
      renderLd: () => null,
    };
    expect(routeTags(headFromMeta(meta, renderers))).toEqual([]);
  });

  test('adds no ld+json tag when renderLd is not provided', () => {
    const renderers: HeadRenderers = { renderMeta: () => [] };
    expect(routeTags(headFromMeta(meta, renderers))).toEqual([]);
  });

  test('overrides participate in the same last-writer-wins merge', () => {
    const renderers: HeadRenderers = {
      renderMeta: () => [{ kind: 'meta', key: 'meta:description', content: 'first' }],
    };
    const overrides: HeadTag[] = [{ kind: 'meta', key: 'meta:description', content: 'second' }];
    const tags = headFromMeta(meta, renderers, overrides);
    expect(routeTags(tags)).toEqual([{ kind: 'meta', key: 'meta:description', content: 'second' }]);
  });
});

describe('renderHead', () => {
  test('void kinds render as a single self-closing-style tag with no closing tag', () => {
    const html = renderHead([{ kind: 'meta', key: 'meta:x', attrs: { name: 'x' } }]);
    expect(html).toBe('<meta name="x">');
    expect(html).not.toContain('</meta>');
  });

  test('link and base are void too', () => {
    expect(renderHead([{ kind: 'link', key: 'link:x', attrs: { rel: 'canonical' } }])).toBe(
      '<link rel="canonical">',
    );
    expect(renderHead([{ kind: 'base', key: 'base', attrs: { href: '/' } }])).toBe(
      '<base href="/">',
    );
  });

  test('non-void kinds render open, content, then close', () => {
    expect(renderHead([{ kind: 'title', key: 'title', content: 'Hi' }])).toBe('<title>Hi</title>');
    expect(renderHead([{ kind: 'script', key: 'script:a', content: 'var x=1;' }])).toBe(
      '<script>var x=1;</script>',
    );
    expect(renderHead([{ kind: 'style', key: 'style:a', content: 'a{}' }])).toBe(
      '<style>a{}</style>',
    );
  });

  test('boolean-true attrs render as a bare attribute name', () => {
    const html = renderHead([{ kind: 'script', key: 'script:a', attrs: { defer: true } }]);
    expect(html).toBe('<script defer></script>');
    expect(html).not.toContain('defer="true"');
  });

  test('non-boolean attr values render as name="value"', () => {
    const html = renderHead([{ kind: 'meta', key: 'meta:a', attrs: { name: 'a', content: 'b' } }]);
    expect(html).toBe('<meta name="a" content="b">');
  });

  test('attribute values are escaped for &, " and < (not >, which is not in the escape set)', () => {
    const html = renderHead([{ kind: 'meta', key: 'meta:a', attrs: { content: '<a> & "b"' } }]);
    expect(html).toBe('<meta content="&lt;a> &amp; &quot;b&quot;">');
  });

  test('title content is escaped for &, < and >', () => {
    expect(renderHead([{ kind: 'title', key: 'title', content: '<a> & b' }])).toBe(
      '<title>&lt;a&gt; &amp; b</title>',
    );
  });

  test('script and style content are emitted raw, not escaped', () => {
    const scriptHtml = renderHead([
      { kind: 'script', key: 'script:a', content: 'if(1<2){var t=1}' },
    ]);
    expect(scriptHtml).toBe('<script>if(1<2){var t=1}</script>');
    expect(scriptHtml).not.toContain('&lt;');

    const styleHtml = renderHead([{ kind: 'style', key: 'style:a', content: 'a<b & c>d' }]);
    expect(styleHtml).toBe('<style>a<b & c>d</style>');
    expect(styleHtml).not.toContain('&lt;');
  });

  test('a tag with no content renders empty content, not the string "undefined"', () => {
    expect(renderHead([{ kind: 'title', key: 'title' }])).toBe('<title></title>');
  });
});

describe('themeScript', () => {
  test('defaults to attrs-less script keyed script:theme', () => {
    const tag = themeScript();
    expect(tag.kind).toBe('script');
    expect(tag.key).toBe('script:theme');
    expect(tag.attrs).toBeUndefined();
    expect(typeof tag.content).toBe('string');
  });

  test('the script checks localStorage under the default key and falls back to matchMedia', () => {
    const tag = themeScript();
    expect(tag.content).toContain('localStorage.getItem("x-theme")');
    expect(tag.content).toContain('matchMedia("(prefers-color-scheme: dark)")');
    expect(tag.content).toContain('document.documentElement.setAttribute("data-theme"');
  });

  test('custom attribute/storageKey options appear in the emitted source', () => {
    const tag = themeScript({ attribute: 'data-x-theme', storageKey: 'my-theme' });
    expect(tag.content).toContain('localStorage.getItem("my-theme")');
    expect(tag.content).toContain('document.documentElement.setAttribute("data-x-theme"');
    expect(tag.content).not.toContain('localStorage.getItem("x-theme")');
    expect(tag.content).not.toContain('setAttribute("data-theme"');
  });

  test('throws BudgetExceededError when the script exceeds maxBytes', () => {
    expect(() => themeScript({ maxBytes: 1 })).toThrow(BudgetExceededError);
  });

  test('THEME_SCRIPT_MAX_BYTES is the documented default cap of 512', () => {
    expect(THEME_SCRIPT_MAX_BYTES).toBe(512);
  });

  test('a script within the default cap does not throw', () => {
    expect(() => themeScript()).not.toThrow();
  });
});

describe('documentBaseline', () => {
  // Every deployed Ultimate app rendered zoomed-out on a phone because of the missing one.
  test('every document carries charset, viewport and color-scheme', () => {
    const keys = documentBaseline().map((tag) => tag.key);
    expect(keys).toEqual(['meta:charset', 'meta:viewport', 'meta:color-scheme']);
  });

  test('they arrive through headFromMeta, ahead of the seo tags', () => {
    const html = renderHead(headFromMeta({ title: 'T' } as never, { renderMeta: () => [] }));
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  // Baseline, not a lock: an app that wants `maximum-scale` or a fixed width must be able to say
  // so, and merge order is what makes "first, but overridable" one rule instead of two.
  test('a route override still wins', () => {
    const html = renderHead(
      headFromMeta({ title: 'T' } as never, { renderMeta: () => [] }, [
        { kind: 'meta', key: 'meta:viewport', attrs: { name: 'viewport', content: 'width=420' } },
      ]),
    );
    expect(html).toContain('content="width=420"');
    expect(html).not.toContain('width=device-width');
  });
});
