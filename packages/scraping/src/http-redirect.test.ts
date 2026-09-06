import { describe, expect, test } from 'bun:test';
import { MAX_REDIRECT_HOPS, redirectHop } from './http-redirect';

describe('unit · which answers are a hop, and where the hop goes', () => {
  test('a 200 is the answer, and so is a 3xx with no Location', () => {
    expect(redirectHop(200, null, 'https://api.test/a', 'GET', undefined)).toBeUndefined();
    expect(redirectHop(302, null, 'https://api.test/a', 'GET', undefined)).toBeUndefined();
    expect(redirectHop(302, '   ', 'https://api.test/a', 'GET', undefined)).toBeUndefined();
  });

  test('300 is NOT a hop — multiple choices names no single target', () => {
    expect(redirectHop(300, '/b', 'https://api.test/a', 'GET', undefined)).toBeUndefined();
  });

  test('a relative Location resolves against the hop it came from, not against the origin', () => {
    expect(redirectHop(302, '../v2/orders', 'https://api.test/v1/a/b', 'GET', undefined)?.url).toBe(
      'https://api.test/v1/v2/orders',
    );
    expect(redirectHop(302, '//cdn.test/x', 'https://api.test/a', 'GET', undefined)?.url).toBe(
      'https://cdn.test/x',
    );
  });

  test('a Location that will not parse is NOT followed — a URL nothing can screen is not requested', () => {
    expect(redirectHop(302, 'http://[not a url', 'about:blank', 'GET', undefined)).toBeUndefined();
  });

  test('303 and a redirected POST become a GET with no body; 307/308 carry both', () => {
    expect(redirectHop(303, '/done', 'https://api.test/a', 'POST', '{"q":1}')).toEqual({
      url: 'https://api.test/done',
      method: 'GET',
      body: undefined,
    });
    expect(redirectHop(302, '/done', 'https://api.test/a', 'POST', '{"q":1}')?.method).toBe('GET');
    expect(redirectHop(307, '/done', 'https://api.test/a', 'POST', '{"q":1}')).toEqual({
      url: 'https://api.test/done',
      method: 'POST',
      body: '{"q":1}',
    });
    expect(redirectHop(308, '/done', 'https://api.test/a', 'PUT', '{"q":1}')?.method).toBe('PUT');
  });

  test('a 303 after a GET stays a GET, and a HEAD stays a HEAD', () => {
    expect(redirectHop(303, '/done', 'https://api.test/a', 'HEAD', undefined)?.method).toBe('HEAD');
  });

  test('the hop ceiling is a number the refusal can quote', () => {
    expect(MAX_REDIRECT_HOPS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_REDIRECT_HOPS)).toBe(true);
  });
});
