import { describe, expect, test } from 'bun:test';
import { linkTarget } from './link-target';

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
