// unit — the split of a search string into the read's input and the route's page controls, and
// every refusal, each of them the read's own `X_INPUT_INVALID` rather than `paginate`'s
// `X_INVARIANT`: a number the caller typed is a 400, never a 500.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { MAX_PAGE_SIZE } from '@ultimat3/entity';
import { assertMaxPage, MAX_WIRE_PAGE_SIZE, pageControlsOf } from './page-controls';

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

  // `_first=10000` over the wire, times the per-IP budget, is a full-table read per request: the
  // wire's bound is MAX_WIRE_PAGE_SIZE, and only a read that declares `maxPage` raises it.
  test('the wire bound is MAX_WIRE_PAGE_SIZE (500), checked here as a 400', () => {
    expect(MAX_WIRE_PAGE_SIZE).toBe(500);
    expect(pageControlsOf('orgFeed', { _first: '500' }).page).toEqual({ first: 500 });
    expect(refusal({ _first: '501' })).toContain('X_INPUT_INVALID');
    expect(refusal({ _first: '501' })).toContain('between 1 and 500');
    expect(refusal({ _first: '0' })).toContain('X_INPUT_INVALID');
  });

  test('a declared maxPage raises the wire bound, up to the one paginate() asserts', () => {
    expect(pageControlsOf('orgFeed', { _first: '2000' }, 2000).page).toEqual({ first: 2000 });
    expect(() => pageControlsOf('orgFeed', { _first: '2001' }, 2000)).toThrow('between 1 and 2000');
    expect(
      pageControlsOf('orgFeed', { _first: String(MAX_PAGE_SIZE) }, MAX_PAGE_SIZE).page,
    ).toEqual({ first: MAX_PAGE_SIZE });
  });

  test('a maxPage no page can hold is X_QUERY_MAX_PAGE_INVALID where it is declared', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PAGE_SIZE + 1, '9']) {
      try {
        assertMaxPage(bad);
        expect.unreachable(`maxPage ${String(bad)} was accepted`);
      } catch (error) {
        expect(isUltimateError(error) ? error.code : String(error)).toBe(
          'X_QUERY_MAX_PAGE_INVALID',
        );
      }
    }
    expect(() => assertMaxPage(undefined)).not.toThrow();
    expect(() => assertMaxPage(1)).not.toThrow();
    expect(() => assertMaxPage(MAX_PAGE_SIZE)).not.toThrow();
  });

  test('a lenient parse is not a page size', () => {
    for (const size of ['1e3', ' 2', '2.0', '-1', '', 'twenty']) {
      expect(refusal({ _first: size })).toContain('_first must be a whole number');
    }
  });

  // `?__proto__=a&__proto__=b` decodes to a repeated key, so the value is an ARRAY — which is what
  // `Object.prototype.__proto__`'s setter accepts. Assigned into a `{}` it swapped the input's
  // prototype for that array, and every `in`/inherited-property read below this line then answered
  // for `['a','b']`: `'length' in input` was true, so a schema asking whether a field was sent got
  // a yes about a field nobody sent. `@ultimat3/http`'s own query collector has built these
  // null-prototype since the same bug was fixed there.
  test('a __proto__ key is data, not a prototype swap', () => {
    // Built the way `@ultimat3/http` builds a search string — a null-prototype record with an OWN
    // `__proto__` key — because an object LITERAL spelling `__proto__:` sets its own prototype
    // instead, and a test written that way passes against the defect.
    const values: Record<string, string | readonly string[]> = Object.create(null);
    // `defineProperty`, because writing `values['__proto__']` is the accessor biome's `noProto`
    // refuses — and on a null-prototype object there is no accessor to reach anyway.
    Object.defineProperty(values, '__proto__', {
      value: ['a', 'b'],
      enumerable: true,
      writable: true,
      configurable: true,
    });
    values['_first'] = '10';

    const split = pageControlsOf('orgFeed', values);

    expect(Object.getPrototypeOf(split.input)).toBeNull();
    expect('length' in split.input).toBe(false);
    expect(Object.hasOwn(split.input, '__proto__')).toBe(true);
    expect(split.page).toEqual({ first: 10 });
  });

  test('a cursor without a size, an empty cursor, and a repeated control are each refused', () => {
    expect(refusal({ _after: 'c' })).toContain('_after was sent without _first');
    expect(refusal({ _first: '1', _after: '' })).toContain('_after is empty');
    expect(refusal({ _first: ['1', '2'] })).toContain('_first was sent 2 times');
    expect(refusal({ _first: '1', _after: ['a', 'b'] })).toContain('_after was sent 2 times');
  });
});
