// The overlay is a dev-only surface, which is exactly why it is tested: it is the screen an
// agent debugs from, and it must show the same facts the terminal and `--json` do. An
// escaping slip or a field silently dropped from the render turns that screen into a lie.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { bodyInvalid, routeNotFound } from './errors';
import { overlayResponse, renderOverlay, wantsOverlay } from './overlay';
import { cspHashSource } from './security-headers';
import { createServer } from './server';

describe('wantsOverlay', () => {
  test('true when the client accepts html', () => {
    const request = new Request('https://example.com/x', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(wantsOverlay(request)).toBe(true);
  });

  test('false when the client wants json', () => {
    const request = new Request('https://example.com/x', {
      headers: { accept: 'application/json' },
    });
    expect(wantsOverlay(request)).toBe(false);
  });

  test('false when there is no accept header at all', () => {
    const request = new Request('https://example.com/x');
    expect(wantsOverlay(request)).toBe(false);
  });
});

describe('renderOverlay', () => {
  test('contains a style block and the escaped facts', () => {
    const error = routeNotFound('GET', '/missing');
    const markup = renderOverlay(error);
    expect(markup).toContain('<style>');
    expect(markup).toContain('X_ROUTE_NOT_FOUND');
    expect(markup).toContain('no route registered for GET /missing');
    expect(markup).toContain('x routes list --json');
    expect(markup).toContain('https://ultimate.dev/errors/X_ROUTE_NOT_FOUND');
  });

  test('escapes html embedded in the cause instead of injecting it raw', () => {
    const error = bodyInvalid('/x', ['<img src=x>']);
    const markup = renderOverlay(error);
    expect(markup).toContain('&lt;img src=x&gt;');
    expect(markup).not.toContain('<img src=x>');
  });

  test('a route pair appears when method or path is provided', () => {
    const error = routeNotFound('GET', '/missing');
    const withBoth = renderOverlay(error, { method: 'GET', path: '/missing' });
    expect(withBoth).toContain('<dt>route</dt><dd>GET /missing</dd>');

    const methodOnly = renderOverlay(error, { method: 'POST' });
    expect(methodOnly).toContain('<dt>route</dt><dd>POST</dd>');

    const pathOnly = renderOverlay(error, { path: '/only' });
    expect(pathOnly).toContain('<dt>route</dt><dd>/only</dd>');
  });

  test('no route label when both method and path are omitted', () => {
    const error = routeNotFound('GET', '/missing');
    const markup = renderOverlay(error);
    expect(markup).not.toContain('<dt>route</dt>');
  });

  test('request id appears only when provided', () => {
    const error = routeNotFound('GET', '/missing');
    const withId = renderOverlay(error, { requestId: 'req-123' });
    expect(withId).toContain('<dt>request</dt><dd>req-123</dd>');

    const withoutId = renderOverlay(error);
    expect(withoutId).not.toContain('<dt>request</dt>');
  });

  test('build id appears only when present and non-null', () => {
    const error = routeNotFound('GET', '/missing');
    const withBuild = renderOverlay(error, { buildId: 'build-9' });
    expect(withBuild).toContain('<dt>build</dt><dd>build-9</dd>');

    const nullBuild = renderOverlay(error, { buildId: null });
    expect(nullBuild).not.toContain('<dt>build</dt>');

    const omittedBuild = renderOverlay(error);
    expect(omittedBuild).not.toContain('<dt>build</dt>');
  });

  test('the json section contains the pretty-printed problem document', () => {
    const error = routeNotFound('GET', '/missing');
    const markup = renderOverlay(error);
    expect(markup).toContain('<h2>json</h2>');
    expect(markup).toContain('&quot;code&quot;: &quot;X_ROUTE_NOT_FOUND&quot;');
  });
});

describe('overlayResponse', () => {
  test('mirrors renderOverlay in a Response with the right status and headers', async () => {
    const error = bodyInvalid('/x', ['title: required']);
    const meta = { method: 'POST', path: '/x', requestId: 'req-1' };
    const response = overlayResponse(error, meta);

    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toStartWith('text/html');

    const body = await response.text();
    expect(body).toBe(renderOverlay(error, meta));
  });
});

/**
 * The regression this file exists to pin, stated once: whatever `<style>` a response carries must
 * be admitted by the CSP that same response sends. The framework shipped an overlay — and a page —
 * whose 64kb of inline CSS the browser refused to parse, and no test asked this question.
 */
const uncoveredStyles = (body: string, csp: string): readonly string[] =>
  [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1] ?? '')
    .filter((css) => !csp.includes(cspHashSource(css)));

describe('the overlay under the policy the same response sends', () => {
  const boom = (): never => {
    throw routeNotFound('GET', '/missing');
  };

  const serve = (): ReturnType<typeof createServer> =>
    createServer({
      routes: [
        { method: 'GET', path: '/boom', meta: { name: 'boom', auth: 'public' }, handler: boom },
      ],
      role: 'web',
      // `dev` turns the overlay on; `reportOnly: false` is what an app that wants CSP violations
      // to actually block in development sets, and it is the only way this assertion can fail.
      config: defineHttpConfig({ dev: true, security: { csp: { reportOnly: false } } }),
    });

  test('every inline style in the rendered overlay is covered by the response CSP', async () => {
    const response = await serve().fetch(
      new Request('http://dev.test/boom', { headers: { accept: 'text/html' } }),
    );
    const body = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(body).toContain('<style>');
    expect(csp).toContain("style-src 'self' 'sha256-");
    expect(uncoveredStyles(body, csp)).toEqual([]);
  });

  test('a body the policy does not name is what the assertion reports', () => {
    expect(uncoveredStyles('<style>a{}</style>', "style-src 'self'")).toEqual(['a{}']);
  });
});
