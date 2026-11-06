import { describe, expect, test } from 'bun:test';
import { currentOf } from './nav-list-view';

const items = [{ href: '/' }, { href: '/runs' }, { href: '/runs/new' }, { href: '/settings' }];

describe('currentOf', () => {
  test('/runs/7 marks /runs, not /', () => {
    expect(currentOf(items, '/runs/7')).toBe(1);
  });

  test('the longest covering href wins, query and fragment ignored', () => {
    expect(currentOf(items, '/runs/new?draft=1#top')).toBe(2);
    expect(currentOf(items, '/settings/')).toBe(3);
  });

  test('a prefix that is not a whole segment does not cover', () => {
    expect(currentOf([{ href: '/run' }, { href: '/' }], '/runs')).toBe(1);
    expect(currentOf([{ href: '/run' }], '/runs')).toBe(-1);
  });

  test('two equal hrefs: the first wins, never both', () => {
    expect(currentOf([{ href: '/a' }, { href: '/a' }], '/a/b')).toBe(0);
  });
});
