// The overlay is a dev-only surface, which is exactly why it is tested: it is the screen an
// agent debugs from, and it must show the same facts the terminal and `--json` do. An
// escaping slip or a field silently dropped from the render turns that screen into a lie.
import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { bodyInvalid, routeNotFound } from './errors';
import type { OverlayNotice } from './overlay';
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
    expect(markup).toContain(ERROR_DOCS_URL);
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

/**
 * The error card carries a docs link and a fix of its own, so every assertion about a NOTICE's
 * link or fix has to be scoped to the notices card — otherwise it passes on the error's markup
 * and the whole block proves nothing.
 */
const noticesCardOf = (markup: string): string => {
  const start = markup.indexOf('<section class="card notices">');
  return start === -1 ? '' : markup.slice(start, markup.indexOf('</section>', start));
};

/** The exact bytes that join the card above the terminal card to it. */
const TERMINAL_JOIN = '  </section>\n  <section class="card">\n    <h2>terminal</h2>';

describe('renderOverlay notices', () => {
  const error = routeNotFound('GET', '/missing');
  const nPlusOne: OverlayNotice = {
    code: 'X_N_PLUS_ONE_QUERY',
    cause: '31 identical selects on post.author in one request',
    fix: 'x db preload post.author',
  };

  test('a request with no findings renders the overlay that shipped before notices existed', () => {
    const meta = { method: 'GET', path: '/missing', requestId: 'req-1' };
    const absent = renderOverlay(error, meta);

    expect(renderOverlay(error, { ...meta, notices: [] })).toBe(absent);
    expect(absent).not.toContain('<h2>notices</h2>');
    // Byte-level, because an empty card is not the only way to make a host pay: a stray blank
    // line at the insertion point is a diff in every dev overlay the framework has ever rendered.
    expect(absent).toContain(TERMINAL_JOIN);
  });

  test('a notice renders the same code/cause/fix contract the error card does', () => {
    const card = noticesCardOf(renderOverlay(error, { notices: [nPlusOne] }));

    expect(card).toContain('<h2>notices</h2>');
    expect(card).toContain('<dt>X_N_PLUS_ONE_QUERY</dt>');
    expect(card).toContain('31 identical selects on post.author in one request');
    expect(card).toContain('<code>x db preload post.author</code>');
  });

  test('two notices both render, in the order the host reported them', () => {
    const write: OverlayNotice = {
      code: 'X_N_PLUS_ONE_WRITE',
      cause: '31 identical inserts into comments',
      fix: 'x db batch comments',
    };
    const card = noticesCardOf(renderOverlay(error, { notices: [nPlusOne, write] }));

    expect(card).toContain('X_N_PLUS_ONE_QUERY');
    expect(card).toContain('X_N_PLUS_ONE_WRITE');
    expect(card.indexOf('X_N_PLUS_ONE_QUERY')).toBeLessThan(card.indexOf('X_N_PLUS_ONE_WRITE'));
  });

  test('the card sits between the error and the terminal, never after the json dump', () => {
    const markup = renderOverlay(error, { notices: [nPlusOne] });

    // Both receivers are pinned present first — a heading this render never emitted is `-1`,
    // which sits before every real offset, so "the card is between them" would hold on a page
    // with no error headline and no notices card at all.
    expect(markup).toContain(`<h1>${error.code} `);
    expect(markup).toContain('<h2>notices</h2>');
    expect(markup.indexOf(`<h1>${error.code} `)).toBeLessThan(markup.indexOf('<h2>notices</h2>'));
    expect(markup.indexOf('<h2>notices</h2>')).toBeLessThan(markup.indexOf('<h2>terminal</h2>'));
    expect(markup).toContain(TERMINAL_JOIN);
  });

  test('docs is a link when the notice carries one, and no anchor at all when it does not', () => {
    const url = ERROR_DOCS_URL;
    const linked = noticesCardOf(renderOverlay(error, { notices: [{ ...nPlusOne, docs: url }] }));
    expect(linked).toContain(`<a href="${url}">${url}</a>`);

    const bare = noticesCardOf(renderOverlay(error, { notices: [nPlusOne] }));
    expect(bare).not.toContain('<a href');
  });

  test('html in a notice is escaped — a diagnostic is not a way to script the overlay', () => {
    const markup = renderOverlay(error, {
      notices: [
        {
          code: '<script>alert(1)</script>',
          cause: '<img src=x onerror=alert(2)>',
          fix: 'x fix "<b>now</b>"',
          docs: 'https://x.test/?a="b"&c=<d>',
        },
      ],
    });

    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(markup).toContain('x fix &quot;&lt;b&gt;now&lt;/b&gt;&quot;');
    expect(markup).toContain('https://x.test/?a=&quot;b&quot;&amp;c=&lt;d&gt;');
  });

  test('a single quote is escaped too — every attribute here is double-quoted, but the next one written may not be', () => {
    const markup = renderOverlay(error, {
      notices: [{ ...nPlusOne, cause: "it's here" }],
    });

    expect(markup).toContain('it&#39;s here');
    expect(markup).not.toContain("it's here");
  });

  // Escaping does nothing to a scheme: `javascript:alert(1)` survives every entity replacement
  // and is then an href the agent debugging this page clicks.
  test('a docs value that is not an http(s) URL is rendered as text, never as an href', () => {
    const card = noticesCardOf(
      renderOverlay(error, { notices: [{ ...nPlusOne, docs: 'javascript:alert(1)' }] }),
    );

    expect(card).not.toContain('<a href');
    expect(card).toContain('javascript:alert(1)');
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

  test('notices reach the body through the same meta object, unwrapped', async () => {
    const meta = {
      path: '/x',
      notices: [{ code: 'X_N_PLUS_ONE_QUERY', cause: '31 selects', fix: 'x db preload' }],
    };
    const body = await overlayResponse(bodyInvalid('/x', ['title: required']), meta).text();

    expect(body).toContain('<h2>notices</h2>');
    expect(body).toContain('X_N_PLUS_ONE_QUERY');
    expect(body).toContain('<code>x db preload</code>');
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
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        dev: true,
        security: { csp: { reportOnly: false } },
      }),
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
