// `x shot`'s one argument: a path on the app, never a URL — refused at the argument, where the
// reader can still see why — and the directory name it photographs into.

import { describe, expect, test } from 'bun:test';
import { readRoute, shotSlug } from './shot-route';

describe('unit · the route argument', () => {
  test('a bare path is normalised, a missing one is a positional error', () => {
    expect([readRoute('/dash'), readRoute('dash'), readRoute(' /a ')]).toEqual([
      '/dash',
      '/dash',
      '/a',
    ]);
    expect(() => readRoute(undefined)).toThrow(/route/);
  });

  // A headless browser inside your network pointed at somebody else's site is the SSRF shape
  // `allowHosts` exists to refuse. Refused at the argument, where the reader can still see why.
  test('an absolute URL is refused, with a runnable route in the fix', () => {
    const error = (() => {
      try {
        readRoute('https://example.com/pricing');
        return {};
      } catch (thrown: unknown) {
        return thrown as Record<string, unknown>;
      }
    })();
    expect([error['code'], error['fix']]).toEqual(['X_CLI_BAD_FLAG', 'x shot /pricing --json']);
  });

  test('a slug can never climb out of the output directory', () => {
    expect([shotSlug('/'), shotSlug('/posts/[slug]'), shotSlug('/../../etc')]).toEqual([
      'root',
      'posts-slug',
      'etc',
    ]);
  });
});

describe('unit · a route that leaves the origin is not a route', () => {
  const refusal = (raw: string): Record<string, unknown> => {
    try {
      readRoute(raw);
      return {};
    } catch (thrown: unknown) {
      return thrown as Record<string, unknown>;
    }
  };

  /**
   * The layer whose own comment says a route can never be an origin, refusing the four spellings
   * that made it one. Every one is `new URL(raw, 'http://localhost:4321')` landing on
   * `http://evil.example/x`: a leading `//` is a protocol-relative URL, a backslash IS a slash to
   * every URL parser, and a tab is DELETED by the parser before the path is read — so `x shot
   * //localhost:9200/_cat/indices` photographed whatever else was on the dev box. The host check
   * one layer down (`allowHostsFrom`) never saw it: it names hostnames, and the hostname it was
   * given was the one the page had already left.
   */
  test('a protocol-relative, backslashed or tab-smuggled origin is refused', () => {
    for (const raw of [
      '//evil.example/x',
      '\\\\evil.example\\x',
      '/\\/evil.example/x',
      '/\t/evil.example/x',
      '///evil',
    ]) {
      const error = refusal(raw);
      expect([raw, error['code'], error['fix']]).toEqual([
        raw,
        'X_CLI_BAD_FLAG',
        'x shot /<path> --json',
      ]);
    }
  });

  // The refusal may not cost a route an app really has: a bracketed dynamic segment and a
  // non-ASCII path both resolve on the app's own origin, whatever the parser re-encodes.
  test('a real route is still a route, brackets and accents included', () => {
    expect([readRoute('/posts/[slug]'), readRoute('/caf\u00e9'), readRoute('a/b')]).toEqual([
      '/posts/[slug]',
      '/caf\u00e9',
      '/a/b',
    ]);
  });
});
