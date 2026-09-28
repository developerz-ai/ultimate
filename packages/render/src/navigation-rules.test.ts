// The client router's decisions, as pure functions: which clicks and submits it takes, and what it
// does with an answer. The fallbacks come first — every one of them is a navigation the browser
// must keep, and taking one of those is how a router breaks a working page.
import { describe, expect, test } from 'bun:test';
import {
  answerMovesTab,
  type FormFacts,
  formVerdict,
  type LinkFacts,
  linkVerdict,
  mayPrefetch,
  NAVIGATION_MAX_HOPS,
  NAVIGATION_NO_STORE_REUSE_MS,
  type PrefetchFacts,
  type ResponseFacts,
  responseVerdict,
  reusable,
} from './navigation-rules';

const HERE = 'https://app.test/casos?page=2';

const link = (patch: Partial<LinkFacts> = {}): LinkFacts => ({
  href: 'https://app.test/plazos',
  current: HERE,
  button: 0,
  modified: false,
  defaultPrevented: false,
  target: '',
  download: false,
  rel: '',
  reload: false,
  ...patch,
});

describe('linkVerdict — what the browser keeps', () => {
  test.each([
    ['a handler already took it', { defaultPrevented: true }, 'prevented'],
    ['a middle click', { button: 1 }, 'modified'],
    ['cmd/ctrl/shift/alt + click', { modified: true }, 'modified'],
    ['target="_blank"', { target: '_blank' }, 'target'],
    ['a named target', { target: 'preview' }, 'target'],
    ['download', { download: true }, 'download'],
    ['rel="external"', { rel: 'noopener external' }, 'external'],
    ['data-x-reload', { reload: true }, 'opt-out'],
    ['another origin', { href: 'https://other.test/plazos' }, 'cross-origin'],
    ['another port is another origin', { href: 'https://app.test:8443/plazos' }, 'cross-origin'],
    ['mailto:', { href: 'mailto:a@app.test' }, 'cross-origin'],
    ['a fragment on this page', { href: 'https://app.test/casos?page=2#vencidos' }, 'hash'],
  ] as const)('%s', (_name, patch, reason) => {
    expect(linkVerdict(link(patch))).toEqual({ kind: 'native', reason });
  });
});

describe('linkVerdict — what the router takes', () => {
  test('a plain same-origin link', () => {
    expect(linkVerdict(link())).toEqual({ kind: 'soft', url: 'https://app.test/plazos' });
  });

  test('target="_self" stays in this tab', () => {
    expect(linkVerdict(link({ target: '_self' })).kind).toBe('soft');
  });

  test('a fragment on ANOTHER page, and the same path with another query, are navigations', () => {
    expect(linkVerdict(link({ href: 'https://app.test/plazos#hoy' }))).toEqual({
      kind: 'soft',
      url: 'https://app.test/plazos#hoy',
    });
    expect(linkVerdict(link({ href: 'https://app.test/casos?page=3' })).kind).toBe('soft');
  });

  test('the page itself, without a fragment, is a refresh through the router', () => {
    expect(linkVerdict(link({ href: HERE })).kind).toBe('soft');
  });
});

const form = (patch: Partial<FormFacts> = {}): FormFacts => ({
  action: 'https://app.test/casos',
  current: HERE,
  method: 'get',
  enctype: 'application/x-www-form-urlencoded',
  target: '',
  defaultPrevented: false,
  reload: false,
  hasFile: false,
  fields: [],
  ...patch,
});

describe('formVerdict', () => {
  test.each([
    ['a handler already took it', { defaultPrevented: true }, 'prevented'],
    ['a target', { target: '_blank' }, 'target'],
    ['data-x-reload', { reload: true, method: 'post' }, 'opt-out'],
    ['method="dialog"', { method: 'dialog' }, 'method'],
    ['another origin', { action: 'https://pay.test/checkout', method: 'post' }, 'cross-origin'],
    ['a POST carrying a file', { method: 'post', hasFile: true }, 'file'],
    ['a text/plain POST', { method: 'post', enctype: 'text/plain' }, 'encoding'],
  ] as const)('the browser keeps %s', (_name, patch, reason) => {
    expect(formVerdict(form(patch))).toEqual({ kind: 'native', reason });
  });

  test('a GET replaces the action query with the fields, as the browser does', () => {
    const verdict = formVerdict(
      form({
        action: 'https://app.test/casos?stale=1',
        fields: [
          ['q', 'tutela 2026'],
          ['estado', 'activo'],
        ],
      }),
    );
    expect(verdict).toEqual({
      kind: 'get',
      url: 'https://app.test/casos?q=tutela+2026&estado=activo',
    });
  });

  test('a POST is taken, with the encoding its enctype names', () => {
    expect(formVerdict(form({ method: 'post' }))).toEqual({
      kind: 'post',
      url: 'https://app.test/casos',
      encoding: 'urlencoded',
    });
    expect(formVerdict(form({ method: 'post', enctype: 'multipart/form-data' }))).toMatchObject({
      encoding: 'multipart',
    });
  });
});

const answer = (patch: Partial<ResponseFacts> = {}): ResponseFacts => ({
  method: 'GET',
  requested: 'https://app.test/plazos',
  status: 200,
  opaqueRedirect: false,
  location: null,
  contentType: 'text/html; charset=utf-8',
  hops: 0,
  surface: 'web:app',
  nextSurface: 'web:app',
  build: 'b1',
  nextBuild: 'b1',
  scope: 'member:1',
  nextScope: 'member:1',
  ...patch,
});

describe('responseVerdict — a POST is never sent twice', () => {
  test('a redirect no framework server handed over: failed, never re-submitted', () => {
    expect(responseVerdict(answer({ method: 'POST', opaqueRedirect: true, status: 0 }))).toEqual({
      kind: 'failed',
      reason: 'a redirect no framework server handed over',
    });
  });

  test("a 303 the server handed over is followed as the router's own GET", () => {
    expect(
      responseVerdict(
        answer({ method: 'POST', status: 204, location: 'https://app.test/casos/7' }),
      ),
    ).toEqual({ kind: 'follow', url: 'https://app.test/casos/7' });
  });

  test("a redirect to another origin (payment, OAuth) is the browser's — the POST ran once", () => {
    expect(
      responseVerdict(
        answer({ method: 'POST', status: 204, location: 'https://pay.test/checkout' }),
      ),
    ).toEqual({ kind: 'load', url: 'https://pay.test/checkout', reason: 'another origin' });
  });

  test('a download answered to a POST is handed over from the bytes received', () => {
    expect(responseVerdict(answer({ method: 'POST', contentType: 'application/zip' }))).toEqual({
      kind: 'hand-over',
    });
  });

  test('a POST answered in place is shown, whatever surface or build rendered it', () => {
    expect(responseVerdict(answer({ method: 'POST', nextSurface: null, nextBuild: 'b2' }))).toEqual(
      { kind: 'swap' },
    );
  });
});

describe('responseVerdict — a GET runs once', () => {
  test('the server asked for this URL as a document: the browser loads it, nothing ran yet', () => {
    expect(responseVerdict(answer({ status: 204, location: 'https://app.test/plazos' }))).toEqual({
      kind: 'load',
      url: 'https://app.test/plazos',
      reason: 'the server asked for a document load',
    });
  });

  test('a non-page answer (a download) is handed over — never asked for again', () => {
    expect(responseVerdict(answer({ contentType: 'application/pdf' }))).toEqual({
      kind: 'hand-over',
    });
  });

  test('an empty 204 is where the browser stays', () => {
    expect(responseVerdict(answer({ status: 204 }))).toEqual({ kind: 'stay' });
  });

  test('a redirect loop is handed to the browser after NAVIGATION_MAX_HOPS', () => {
    const loop = answer({ status: 204, location: 'https://app.test/a', hops: NAVIGATION_MAX_HOPS });
    expect(responseVerdict(loop)).toMatchObject({ kind: 'load', reason: 'too many redirects' });
    expect(responseVerdict({ ...loop, hops: 0 })).toEqual({
      kind: 'follow',
      url: 'https://app.test/a',
    });
  });
});

describe('responseVerdict — fallbacks where no framework server answered (a static host)', () => {
  test('an opaque redirect on a GET is loaded by the browser', () => {
    expect(responseVerdict(answer({ opaqueRedirect: true, status: 0 }))).toMatchObject({
      kind: 'load',
      url: 'https://app.test/plazos',
    });
  });

  test('another surface or app, another build, another principal: a full load', () => {
    expect(responseVerdict(answer({ nextSurface: 'web:site' }))).toMatchObject({
      reason: 'another surface',
    });
    expect(responseVerdict(answer({ nextSurface: 'admin:app' }))).toMatchObject({
      reason: 'another surface',
    });
    expect(responseVerdict(answer({ nextSurface: null }))).toMatchObject({ kind: 'load' });
    // A 409 refused for skew is not a page to show: it is loaded.
    expect(responseVerdict(answer({ status: 409, nextBuild: 'b2' }))).toMatchObject({
      reason: 'another build',
    });
    expect(responseVerdict(answer({ nextScope: null }))).toMatchObject({
      reason: 'another principal',
    });
  });

  test('same surface, build and principal is a swap; a 404 page too', () => {
    expect(responseVerdict(answer())).toEqual({ kind: 'swap' });
    expect(responseVerdict(answer({ status: 404 }))).toEqual({ kind: 'swap' });
    expect(responseVerdict(answer({ nextBuild: null }))).toEqual({ kind: 'swap' });
  });
});

describe('reusable — what a prefetched answer may stand in for', () => {
  const held = { status: 200, html: true, location: null, noStore: false, ageMs: 20_000 };

  test.each([
    ['a failure', { status: 500 }],
    ['a 404', { status: 404 }],
    ['an empty 204 (the route did not opt in)', { status: 204, html: false }],
    ['a hand-over (a login wall)', { status: 204, location: 'https://app.test/login' }],
    ['not a page', { html: false }],
    ['no-store, clicked too late', { noStore: true, ageMs: NAVIGATION_NO_STORE_REUSE_MS }],
  ] as const)('never %s', (_name, patch) => {
    expect(reusable({ ...held, ...patch })).toBe(false);
  });

  test('a page; a no-store page clicked within the window', () => {
    expect(reusable(held)).toBe(true);
    expect(reusable({ ...held, noStore: true, ageMs: NAVIGATION_NO_STORE_REUSE_MS - 1 })).toBe(
      true,
    );
  });
});

describe('mayPrefetch — a guess is a GET nobody asked for', () => {
  const at = (url: string, patch: Partial<PrefetchFacts> = {}): boolean =>
    mayPrefetch({ url: `https://app.test${url}`, noPrefetch: false, ...patch });

  test.each([
    ['data-x-no-prefetch', '/r/abc', { noPrefetch: true }],
    ['Save-Data', '/plazos', { saveData: true }],
    ['a 2g connection', '/plazos', { effectiveType: '2g' }],
    ['a slow-2g connection', '/plazos', { effectiveType: 'slow-2g' }],
  ] as const)('never under %s', (_name, url, patch) => {
    expect(at(url, patch)).toBe(false);
  });

  test('a path is no reason: the server refuses a prefetch of any route that did not opt in', () => {
    expect(at('/logout')).toBe(true);
    expect(at('/cerrar-sesion')).toBe(true);
  });

  test.each(['/plazos', '/blog/signs-of-outage', '/catalog/outlet', '/logs', '/signup'])(
    'an ordinary path is fetched on intent: %s',
    (path) => {
      expect(at(path)).toBe(true);
      expect(at(path, { effectiveType: '4g', saveData: false })).toBe(true);
    },
  );
});

describe('N1/N2 — an answer that cannot be asked for again is shown, and the tab stops trusting itself', () => {
  test("a GET's error page without the surface meta is swapped, never re-requested", () => {
    for (const status of [404, 500, 503]) {
      expect(responseVerdict(answer({ status, nextSurface: null, nextScope: null }))).toEqual({
        kind: 'swap',
      });
    }
  });

  test('a POST answered in place for another principal or build moves the tab', () => {
    expect(answerMovesTab(answer({ method: 'POST', nextScope: 'member:2' }))).toBe(true);
    expect(answerMovesTab(answer({ method: 'POST', nextScope: null }))).toBe(true);
    expect(answerMovesTab(answer({ method: 'POST', nextBuild: 'b2' }))).toBe(true);
    expect(answerMovesTab(answer({ method: 'POST' }))).toBe(false);
    expect(answerMovesTab(answer({ method: 'POST', nextBuild: null }))).toBe(false);
  });
});
