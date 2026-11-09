// `disallowMatcher` is asked once per sitemap URL, and the URLs are app data (a slug per row). It
// compiled each rule to a backtracking `RegExp` with one `.*` per `*`: eleven wildcards against a
// 41-character path took 14 seconds, and one more character doubles it.

import { describe, expect, test } from 'bun:test';
import { disallowMatcher } from './robots';

describe('disallowMatcher reads a rule as a crawler does', () => {
  test.each([
    ['/admin', '/admin', true],
    ['/admin', '/admin/users', true],
    ['/admin', '/administrator', true],
    ['/admin', '/blog/admin', false],
    ['/*.pdf$', '/files/a.pdf', true],
    ['/*.pdf$', '/files/a.pdf?x=1', false],
    ['/*.pdf', '/files/a.pdf?x=1', true],
    ['/a*b*c', '/a-c-b-c', true],
    ['/a*b*c', '/a-c-b', false],
    ['/p$', '/p', true],
    ['/p$', '/pp', false],
    ['/x*$', '/x/anything', true],
    ['/a$b', '/a$b/c', true],
    ['/q?id=', '/q?id=7', true],
    ['/q?id=', '/qid=7', false],
    ['*', '/anything', true],
    ['/ab*ab$', '/ab', false],
    ['/ab*ab$', '/abab', true],
    ['', '/anything', false],
  ])('%s against %s → %p', (rule, path, blocked) => {
    expect(disallowMatcher([rule])(path)).toBe(blocked);
  });

  test('many wildcards against a long path answer in linear time', () => {
    const matches = disallowMatcher(['/*a*a*a*a*a*a*a*a*a*a*b']);
    const started = performance.now();
    expect(matches(`/${'a'.repeat(5000)}`)).toBe(false);
    expect(matches(`/${'a'.repeat(5000)}b`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
