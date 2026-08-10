import { describe, expect, test } from 'bun:test';
import { bodyInvalid, routeNotFound } from './errors';
import { overlayResponse, renderOverlay, wantsOverlay } from './overlay';

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
