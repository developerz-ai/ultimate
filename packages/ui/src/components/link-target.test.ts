import { describe, expect, test } from 'bun:test';
import { linkRel, linkTarget } from './link-target';

describe('linkTarget', () => {
  test('a javascript: href emits no href and is not external', () => {
    expect(linkTarget('javascript:alert(1)')).toEqual({ href: undefined, external: false });
    // `external: true` at the call site must not buy a refused URL a target="_blank".
    expect(linkTarget('javascript:alert(1)', true)).toEqual({ href: undefined, external: false });
  });

  test('the control characters a browser strips cannot smuggle the scheme through', () => {
    expect(linkTarget('java\tscript:alert(1)').href).toBeUndefined();
  });

  test('an internal path is kept and is not external', () => {
    expect(linkTarget('/posts/1')).toEqual({ href: '/posts/1', external: false });
  });

  test('an http(s) URL is kept and is external', () => {
    expect(linkTarget('https://app.test')).toEqual({
      href: 'https://app.test',
      external: true,
    });
  });

  test('every spelling a browser reads as another origin is external, not only "http(s)://"', () => {
    for (const href of [
      '//cdn.test/a.js',
      'HTTPS://app.test',
      'Http://app.test/x',
      ' https://app.test',
    ]) {
      expect(linkTarget(href).external).toBe(true);
    }
  });

  test('a relative URL that merely contains a scheme-like string stays internal', () => {
    for (const href of ['/go?to=https://app.test', 'posts/1', '#top', '?page=2', './https:/x']) {
      expect(linkTarget(href).external).toBe(false);
    }
  });

  test('an explicit external declaration wins for a safe URL', () => {
    expect(linkTarget('/docs', true)).toEqual({ href: '/docs', external: true });
  });

  test('mailto and tel are kept, and are not "external" in the new-tab sense', () => {
    expect(linkTarget('mailto:ada@app.test')).toEqual({
      href: 'mailto:ada@app.test',
      external: false,
    });
  });
});

describe('linkRel', () => {
  test('an internal link with no relation carries no rel at all', () => {
    expect(linkRel(false)).toBeUndefined();
  });

  test('a pager relation is emitted as written', () => {
    expect(linkRel(false, 'next')).toBe('next');
    expect(linkRel(false, 'prev')).toBe('prev');
  });

  // The hardening is not the caller's to drop: a relation is ADDED to it, never traded for it.
  test('an external link keeps its hardening beside a relation', () => {
    expect(linkRel(true)).toBe('noopener noreferrer');
    expect(linkRel(true, 'next')).toBe('next noopener noreferrer');
  });
});
