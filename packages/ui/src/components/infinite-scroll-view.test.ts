// Three states, one of them at a time — plus the rule that keeps the no-JS path real.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES, UiError } from '../errors';
import { loadMoreState } from './infinite-scroll-view';

describe('loadMoreState', () => {
  test('more pages and idle offers the next page', () => {
    expect(loadMoreState({ hasMore: true, nextHref: '/posts?page=2' })).toBe('more');
  });

  test('loading wins, so the control cannot ask twice', () => {
    expect(loadMoreState({ hasMore: true, nextHref: '/posts?page=2', loading: true })).toBe(
      'loading',
    );
  });

  test('no more pages ends the list, href or not', () => {
    expect(loadMoreState({ hasMore: false })).toBe('end');
    expect(loadMoreState({ hasMore: false, loading: false })).toBe('end');
  });

  test('hasMore without a URL is a UiError — a button with no page is not a fallback', () => {
    expect(() => loadMoreState({ hasMore: true })).toThrow(UiError);
    expect(() => loadMoreState({ hasMore: true, nextHref: '' })).toThrow(/nextHref/);
    try {
      loadMoreState({ hasMore: true });
    } catch (error) {
      expect((error as UiError).code).toBe(UI_ERROR_CODES.invalidValue);
    }
  });
});
