// The URL's params merged into a request's input, and the refusal when the two disagree.

import { describe, expect, test } from 'bun:test';
import type { UltimateError } from './errors';
import { HttpPathInputConflictError, mergePathParams } from './route-path-merge';

describe('mergePathParams', () => {
  const at = { owner: 'action "refundOrder"', template: '/orders/:id/refund' };

  test('the URL value joins the body, other body keys untouched', () => {
    expect(mergePathParams({ ...at, params: { id: 'o1' }, raw: { reason: 'x' } })).toEqual({
      reason: 'x',
      id: 'o1',
    });
    expect(mergePathParams({ ...at, params: { id: 'o1' }, raw: undefined })).toEqual({ id: 'o1' });
  });

  test('the same value in both is one value', () => {
    expect(mergePathParams({ ...at, params: { id: 'o1' }, raw: { id: 'o1' } })).toEqual({
      id: 'o1',
    });
  });

  test('a different value in the body is refused, never overridden', () => {
    try {
      mergePathParams({ ...at, params: { id: 'o1' }, raw: { id: 'o2' } });
      expect.unreachable('a conflicting body must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpPathInputConflictError);
      expect((error as UltimateError).code).toBe('X_HTTP_PATH_INPUT_CONFLICT');
      expect((error as UltimateError).cause).toContain(':id');
      expect((error as UltimateError).meta).toEqual({ key: 'id', path: '/orders/:id/refund' });
    }
  });

  test('a body that is not an object is handed on untouched for the schema to refuse', () => {
    expect(mergePathParams({ ...at, params: { id: 'o1' }, raw: ['x'] })).toEqual(['x']);
  });

  test('a static template hands the input on unchanged, whatever the router matched', () => {
    const raw = { a: 1 };
    expect(mergePathParams({ ...at, template: '/s', params: { rest: 'z' }, raw })).toBe(raw);
  });
});
