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

  test('301/302 rewrite a POST and nothing else — a PUT is not turned into a read', () => {
    // The rewrite is POST-only in the fetch standard, and "everything but GET/HEAD loses its body"
    // was the other direction of wrong: a PUT re-asked as a bodyless GET is the caller's write
    // silently not happening, answered 200 by a URL that stored nothing.
    for (const status of [301, 302]) {
      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        expect(redirectHop(status, '/done', 'https://api.test/a', method, '{"q":1}')).toEqual({
          url: 'https://api.test/done',
          method,
          body: '{"q":1}',
        });
      }
      expect(redirectHop(status, '/done', 'https://api.test/a', 'POST', '{"q":1}')).toEqual({
        url: 'https://api.test/done',
        method: 'GET',
        body: undefined,
      });
    }
  });

  test('a 303 rewrites every method but GET and HEAD, PUT included', () => {
    expect(redirectHop(303, '/done', 'https://api.test/a', 'PUT', '{"q":1}')).toEqual({
      url: 'https://api.test/done',
      method: 'GET',
      body: undefined,
    });
  });

  test('the method is read case-insensitively, because fetch normalises it on the way out', () => {
    // `fetch` sends `post` as `POST`, so a decision keyed on the caller's spelling would rewrite
    // one and re-POST the other.
    expect(redirectHop(302, '/done', 'https://api.test/a', 'post', '{"q":1}')?.method).toBe('GET');
    expect(redirectHop(303, '/done', 'https://api.test/a', 'head', undefined)?.method).toBe('head');
  });

  test('the hop ceiling is a number the refusal can quote', () => {
    expect(MAX_REDIRECT_HOPS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_REDIRECT_HOPS)).toBe(true);
  });
});
