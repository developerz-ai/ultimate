// unit — the split of a search string into the read's input and the route's page controls, and
// every refusal, each of them the read's own `X_INPUT_INVALID` rather than `paginate`'s
// `X_INVARIANT`: a number the caller typed is a 400, never a 500.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { MAX_PAGE_SIZE, pageControlsOf } from './page-controls';

const refusal = (values: Parameters<typeof pageControlsOf>[1]): string => {
  try {
    pageControlsOf('orgFeed', values);
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? `${error.code}: ${error.cause}` : String(error);
  }
};

describe('pageControlsOf', () => {
  test('neither control sent is no page, and the input passes through untouched', () => {
    const split = pageControlsOf('orgFeed', { orgId: 'o', tags: ['a', 'b'] });
    expect(split.page).toBeUndefined();
    expect(split.input).toEqual({ orgId: 'o', tags: ['a', 'b'] });
  });

  test('the controls are removed from the input the schema will see', () => {
    const split = pageControlsOf('orgFeed', { orgId: 'o', _first: '2', _after: 'c' });
    expect(split.input).toEqual({ orgId: 'o' });
    expect(split.page).toEqual({ first: 2, after: 'c' });
  });

  test('the bound is the one paginate() asserts, checked here as a 400', () => {
    expect(pageControlsOf('orgFeed', { _first: String(MAX_PAGE_SIZE) }).page).toEqual({
      first: MAX_PAGE_SIZE,
    });
    expect(refusal({ _first: String(MAX_PAGE_SIZE + 1) })).toContain('X_INPUT_INVALID');
    expect(refusal({ _first: '0' })).toContain('X_INPUT_INVALID');
  });

  test('a lenient parse is not a page size', () => {
    for (const size of ['1e3', ' 2', '2.0', '-1', '', 'twenty']) {
      expect(refusal({ _first: size })).toContain('_first must be a whole number');
    }
  });

  test('a cursor without a size, an empty cursor, and a repeated control are each refused', () => {
    expect(refusal({ _after: 'c' })).toContain('_after was sent without _first');
    expect(refusal({ _first: '1', _after: '' })).toContain('_after is empty');
    expect(refusal({ _first: ['1', '2'] })).toContain('_first was sent 2 times');
    expect(refusal({ _first: '1', _after: ['a', 'b'] })).toContain('_after was sent 2 times');
  });
});
