import { describe, expect, test } from 'bun:test';
import { text } from './response';
import { createRouter, describeRoutes, matchRoute, type Route } from './router';

const route = (method: Route['method'], path: string, name = path): Route => ({
  method,
  path,
  handler: () => text(name),
  meta: { name, auth: 'public' },
});

const table = createRouter([
  route('GET', '/posts', 'posts.list'),
  route('POST', '/posts', 'posts.create'),
  route('GET', '/posts/new', 'posts.new'),
  route('GET', '/posts/:id', 'posts.show'),
  route('GET', '/posts/:id/comments/:commentId', 'comments.show'),
  route('GET', '/files/*path', 'files.serve'),
]);

const matched = (method: string, path: string) => {
  const result = matchRoute(table, method, path);
  if (!result.ok) throw new Error(`expected a match for ${method} ${path}: ${result.reason}`);
  return result;
};

describe('precedence', () => {
  test('static beats param at the same depth', () => {
    expect(matched('GET', '/posts/new').route.meta.name).toBe('posts.new');
  });

  test('param is used when no static segment matches', () => {
    const result = matched('GET', '/posts/abc');
    expect(result.route.meta.name).toBe('posts.show');
    expect(result.params).toEqual({ id: 'abc' });
  });

  test('wildcard is last resort and captures the remaining segments', () => {
    const result = matched('GET', '/files/a/b/c.txt');
    expect(result.route.meta.name).toBe('files.serve');
    expect(result.params).toEqual({ path: 'a/b/c.txt' });
  });

  test('a static dead end backtracks into the param branch', () => {
    // `/posts/new` exists but has no `/comments/:id` child; matching must not stop there.
    const result = matched('GET', '/posts/new/comments/7');
    expect(result.route.meta.name).toBe('comments.show');
    expect(result.params).toEqual({ id: 'new', commentId: '7' });
  });
});

describe('params', () => {
  test('multiple params are extracted and percent-decoded', () => {
    const result = matched('GET', '/posts/a%20b/comments/c%2Fd');
    expect(result.params).toEqual({ id: 'a b', commentId: 'c/d' });
  });

  test('trailing slashes and duplicate separators normalise', () => {
    expect(matched('GET', '/posts//new/').route.meta.name).toBe('posts.new');
  });
});

// A pathname is whatever the client typed. `decodeURIComponent('%ZZ')` throws a bare `URIError`,
// which used to escape the match as `X_INTERNAL` — a 500 and an error-monitor page for a typo.
describe('invalid percent-encoding', () => {
  test('a param segment that will not decode is path-invalid, not a throw', () => {
    const result = matchRoute(table, 'GET', '/posts/%ZZ');
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'path-invalid') throw new Error('expected path-invalid');
    expect(result.segment).toBe('%ZZ');
  });

  test('a lone %, and a truncated escape, are both refused the same way', () => {
    for (const bad of ['%', '%A', 'a%2']) {
      const result = matchRoute(table, 'GET', `/posts/${bad}`);
      expect(result.ok ? '' : result.reason).toBe('path-invalid');
    }
  });

  test('a wildcard reports the first bad segment of the tail', () => {
    const result = matchRoute(table, 'GET', '/files/ok/%E0%A4%A/tail');
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'path-invalid') throw new Error('expected path-invalid');
    expect(result.segment).toBe('%E0%A4%A');
  });

  // Static segments are compared raw, so only the branch that would have decoded can fail.
  test('a path that reaches no param or wildcard is the 404 it always was', () => {
    expect(matchRoute(table, 'GET', '/%ZZ')).toEqual({ ok: false, reason: 'not-found' });
  });

  test('a matching branch wins over a sibling that could not decode', () => {
    const both = createRouter([
      route('GET', '/posts/%ZZ', 'posts.literal'),
      route('GET', '/posts/:id'),
    ]);
    const result = matchRoute(both, 'GET', '/posts/%ZZ');
    expect(result.ok ? result.route.meta.name : '').toBe('posts.literal');
  });

  test('the method is still judged for a path that decodes', () => {
    const result = matchRoute(table, 'DELETE', '/posts/a%20b');
    expect(result.ok ? '' : result.reason).toBe('method-not-allowed');
  });
});

describe('methods', () => {
  test('unknown path is not-found, known path with wrong method is 405 data', () => {
    expect(matchRoute(table, 'GET', '/nope')).toEqual({ ok: false, reason: 'not-found' });
    const result = matchRoute(table, 'DELETE', '/posts');
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'method-not-allowed') throw new Error('expected 405');
    expect([...result.allow].sort()).toEqual(['GET', 'HEAD', 'POST']);
  });

  test('HEAD falls back to the GET route', () => {
    expect(matched('HEAD', '/posts').route.meta.name).toBe('posts.list');
  });
});

describe('conflicts', () => {
  test('two routes for the same method and path throw X_ROUTE_CONFLICT', () => {
    expect(() => createRouter([route('GET', '/a'), route('GET', '/a')])).toThrow(
      /X_ROUTE_CONFLICT|already handled/,
    );
  });

  test('two different param names at the same position conflict', () => {
    expect(() => createRouter([route('GET', '/a/:id'), route('GET', '/a/:slug')])).toThrow(
      /X_ROUTE_CONFLICT|:id/,
    );
  });

  test('a wildcard must be the last segment', () => {
    expect(() => createRouter([route('GET', '/a/*rest/b')])).toThrow(/last segment/);
  });
});

describe('describeRoutes', () => {
  test('is deterministic and lists params for the manifest', () => {
    const described = describeRoutes(table);
    expect(described.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      'GET /files/*path',
      'GET /posts',
      'POST /posts',
      'GET /posts/:id',
      'GET /posts/:id/comments/:commentId',
      'GET /posts/new',
    ]);
    const comments = described.find((entry) => entry.name === 'comments.show');
    expect(comments?.params).toEqual(['id', 'commentId']);
    expect(comments?.auth).toBe('public');
    // Named on every row, never left to be inferred from its absence: a described policy
    // with no stated evaluator reads as an unguarded one.
    expect(described.every((entry) => entry.enforcedBy === 'pipeline')).toBe(true);
  });
});
