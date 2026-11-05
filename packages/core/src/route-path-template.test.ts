// The `http.path` template helpers `@ultimat3/action` and `@ultimat3/query` share: shape, params,
// the input-key rule, filling and the OpenAPI spelling.

import { describe, expect, test } from 'bun:test';
import {
  fillTemplate,
  pathTemplateProblem,
  templateKeyProblem,
  templateParams,
  toOpenApiPath,
} from './route-path-template';

describe('pathTemplateProblem', () => {
  test('a static path and a parameterised one are both templates', () => {
    expect(pathTemplateProblem('/api/uploads/signed')).toBeUndefined();
    expect(pathTemplateProblem('/orders/:id/refund')).toBeUndefined();
    expect(pathTemplateProblem('/posts/:postId/publish')).toBeUndefined();
  });

  test.each([
    ['orders', 'is not a lowercase path'],
    ['/Orders', 'is not a lowercase path'],
    ['/orders/', 'is not a lowercase path'],
    ['/orders/*rest', 'is not a lowercase path'],
    ['/orders/:Id', 'is not a lowercase path'],
    ['/orders/:', 'is not a lowercase path'],
  ])('%s is refused', (path, reason) => {
    expect(pathTemplateProblem(path)).toContain(reason);
  });

  test('a non-string, /_x and a repeated param are refused, each with its own reason', () => {
    expect(pathTemplateProblem(42)).toBe('is not a string');
    expect(pathTemplateProblem('/_x/thing')).toContain('/_x');
    expect(pathTemplateProblem('/_x')).toContain('/_x');
    expect(pathTemplateProblem('/a/:id/b/:id')).toContain('repeats :id');
  });
});

describe('templateParams / toOpenApiPath', () => {
  test('names in order, and the OpenAPI spelling', () => {
    expect(templateParams('/orgs/:orgId/posts/:postId')).toEqual(['orgId', 'postId']);
    expect(templateParams('/static/path')).toEqual([]);
    expect(toOpenApiPath('/orgs/:orgId/posts/:postId')).toBe('/orgs/{orgId}/posts/{postId}');
    expect(toOpenApiPath('/static/path')).toBe('/static/path');
  });
});

describe('templateKeyProblem', () => {
  const props = {
    id: { kind: 'string' },
    count: { kind: 'number' },
    maybe: { kind: 'string', optional: true },
    defaulted: { kind: 'string', hasDefault: true },
  };

  test('a required string key passes', () => {
    expect(templateKeyProblem(['id'], props)).toBeUndefined();
    expect(templateKeyProblem([], undefined)).toBeUndefined();
  });

  test.each([
    ['missing', 'is not a key of input:'],
    ['count', 'is not a string'],
    ['maybe', 'is optional'],
    ['defaulted', 'is optional'],
  ])(':%s is refused', (param, reason) => {
    expect(templateKeyProblem([param], props)).toContain(reason);
  });

  test('a schema nothing can introspect cannot prove a key', () => {
    expect(templateKeyProblem(['id'], undefined)).toContain('cannot be introspected');
  });
});

describe('fillTemplate', () => {
  test('substitutes and encodes each value as one segment', () => {
    expect(fillTemplate('/orders/:id/refund', { id: 'a/b c' })).toEqual({
      ok: true,
      path: '/orders/a%2Fb%20c/refund',
    });
    expect(fillTemplate('/static', undefined)).toEqual({ ok: true, path: '/static' });
  });

  test('a missing, empty or non-string value is named', () => {
    expect(fillTemplate('/orders/:id', {})).toEqual({ ok: false, missing: 'id' });
    expect(fillTemplate('/orders/:id', { id: '' })).toEqual({ ok: false, missing: 'id' });
    expect(fillTemplate('/orders/:id', { id: 7 })).toEqual({ ok: false, missing: 'id' });
    expect(fillTemplate('/orders/:id', null)).toEqual({ ok: false, missing: 'id' });
  });
});
