// A cross-site `<form method="post">` reaches a handler with the session cookie attached, and
// CORS never sees it: `application/x-www-form-urlencoded` is a simple content type, so there is
// no preflight and `cors.origins: []` only withholds the reply. These tests pin the one gate
// that decides before the write happens.
import { describe, expect, test } from 'bun:test';
import { type CorsConfig, DEFAULT_CORS } from './cors';
import { type CsrfCheckInput, checkCsrf, DEFAULT_CSRF, selfOrigin } from './csrf';

const cors: CorsConfig = { ...DEFAULT_CORS, origins: ['https://admin.example.com'] };

const input = (patch: Partial<CsrfCheckInput> = {}): CsrfCheckInput => ({
  method: 'POST',
  selfOrigin: 'https://app.example.com',
  origin: null,
  secFetchSite: null,
  hasAuthorizationHeader: false,
  anonymous: false,
  cors,
  config: DEFAULT_CSRF,
  ...patch,
});

describe('checkCsrf', () => {
  // The failure scenario, verbatim: a signed-in user visits evil.test, which auto-submits a form
  // to /api/orders/refund. The policy allows it — they own the order — so the ONLY thing that can
  // stop it is this.
  test('a cross-site form post from a signed-in browser is refused', () => {
    const verdict = checkCsrf(input({ secFetchSite: 'cross-site', origin: 'https://evil.test' }));
    expect(verdict.ok).toBe(false);
  });

  test('same-origin is allowed on sec-fetch-site alone', () => {
    expect(checkCsrf(input({ secFetchSite: 'same-origin' })).ok).toBe(true);
  });

  test('the app own origin is allowed on the Origin header alone', () => {
    expect(checkCsrf(input({ origin: 'https://app.example.com' })).ok).toBe(true);
  });

  test('an origin the app already allows for CORS is allowed here too', () => {
    expect(
      checkCsrf(input({ origin: 'https://admin.example.com', secFetchSite: 'same-site' })).ok,
    ).toBe(true);
  });

  test('same-site is NOT enough on its own — a sibling subdomain must be listed', () => {
    expect(
      checkCsrf(input({ secFetchSite: 'same-site', origin: 'https://blog.example.com' })).ok,
    ).toBe(false);
  });

  test('neither header present is refused: "we could not tell" is the case this exists for', () => {
    expect(checkCsrf(input()).ok).toBe(false);
  });

  test('a safe method is never judged', () => {
    expect(checkCsrf(input({ method: 'GET', secFetchSite: 'cross-site' })).ok).toBe(true);
  });

  // Login CSRF: a hostile page auto-submits the sign-in form with the ATTACKER's credentials, and
  // the visitor is silently signed into the attacker's account. No session exists yet, so
  // "anonymous" is exactly the caller this write has to be judged for.
  test('an anonymous cross-site write is refused — a sign-in form is forgeable too', () => {
    const forged = input({
      anonymous: true,
      secFetchSite: 'cross-site',
      origin: 'https://evil.test',
    });
    expect(checkCsrf(forged).ok).toBe(false);
    // The neighbours: either header alone is browser evidence, and each is judged.
    expect(checkCsrf(input({ anonymous: true, secFetchSite: 'cross-site' })).ok).toBe(false);
    expect(checkCsrf(input({ anonymous: true, origin: 'https://evil.test' })).ok).toBe(false);
    expect(checkCsrf(input({ anonymous: true, secFetchSite: 'same-site' })).ok).toBe(false);
    expect(checkCsrf(input({ anonymous: true, origin: 'null' })).ok).toBe(false);
  });

  test('an anonymous same-origin write is allowed, by either proof', () => {
    expect(checkCsrf(input({ anonymous: true, secFetchSite: 'same-origin' })).ok).toBe(true);
    expect(checkCsrf(input({ anonymous: true, origin: 'https://app.example.com' })).ok).toBe(true);
    expect(checkCsrf(input({ anonymous: true, origin: 'https://admin.example.com' })).ok).toBe(
      true,
    );
  });

  // No session and no browser evidence at all: an inbound webhook, a server-to-server sign-up.
  // There is no ambient credential to ride and no browser to drive, so nothing is forgeable —
  // the SAME request with a session is still refused two tests up.
  test('an anonymous write carrying neither header is not a browser, and passes', () => {
    expect(checkCsrf(input({ anonymous: true })).ok).toBe(true);
    expect(checkCsrf(input({ anonymous: false })).ok).toBe(false);
  });

  // A bearer token is chosen by the caller's own code; a cross-site page cannot make the browser
  // attach one, which is the whole definition of "not ambient".
  test('a bearer caller is exempt', () => {
    expect(checkCsrf(input({ hasAuthorizationHeader: true, secFetchSite: 'cross-site' })).ok).toBe(
      true,
    );
  });

  test("mode: 'off' judges nothing", () => {
    expect(checkCsrf(input({ config: { mode: 'off' }, secFetchSite: 'cross-site' })).ok).toBe(true);
  });

  // `origins: ['*']` with `credentials: false` is the ONLY legal wildcard form — `assertCorsConfig`
  // refuses the other — and `'*'` is a RESPONSE header value: "any origin may read a public reply".
  // Read as a per-origin allowance it says every origin on the internet is same-origin, so the one
  // scenario this file exists for (a signed-in browser auto-submitting evil.test's form) passed.
  test('a wildcard CORS list allows nobody to WRITE with the session cookie', () => {
    const wildcard: CorsConfig = { ...DEFAULT_CORS, origins: ['*'], credentials: false };
    expect(
      checkCsrf(input({ cors: wildcard, origin: 'https://evil.test', secFetchSite: 'cross-site' }))
        .ok,
    ).toBe(false);
    // The same request from a client that sends no `sec-fetch-site` at all — the other half of
    // the wildcard hole, and the one no browser vocabulary check would have caught.
    expect(checkCsrf(input({ cors: wildcard, origin: 'https://evil.test' })).ok).toBe(false);
  });

  test('an exact origin listed beside the wildcard is still allowed', () => {
    const both: CorsConfig = {
      ...DEFAULT_CORS,
      origins: ['*', 'https://admin.example.com'],
      credentials: false,
    };
    expect(
      checkCsrf(
        input({ cors: both, origin: 'https://admin.example.com', secFetchSite: 'same-site' }),
      ).ok,
    ).toBe(true);
  });

  // The reason echoes the request back, and a non-browser writes whatever it likes there. The
  // rejected value never reaches the response body or the log store.
  test('an invented sec-fetch-site value is not quoted back verbatim', () => {
    const verdict = checkCsrf(input({ secFetchSite: '<script>hunter2</script>' }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).not.toContain('hunter2');
  });
});

describe('selfOrigin', () => {
  // Behind a TLS-terminating ingress the internal hop is plain http while the browser's Origin
  // says https, so building this from `url.protocol` would refuse every legitimate form post.
  test('takes the scheme from ctx.https, never from the internal URL', () => {
    expect(selfOrigin(new URL('http://app.example.com/x'), true)).toBe('https://app.example.com');
    expect(selfOrigin(new URL('http://app.example.com/x'), false)).toBe('http://app.example.com');
  });
});
