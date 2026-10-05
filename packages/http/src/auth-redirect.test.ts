import { describe, expect, test } from 'bun:test';
import { nextAfterSignIn, signInRedirect } from './auth-redirect';

const browser = new Request('https://app.test/dashboard', {
  headers: { accept: 'text/html,application/xhtml+xml' },
});
const agent = new Request('https://app.test/dashboard', { headers: { accept: '*/*' } });
const at = (path: string, search = '') =>
  ({ url: new URL(`https://app.test${path}${search}`), method: 'GET' }) as const;

describe('unit · what an unauthenticated browser gets', () => {
  test('a browser is sent to the sign-in page, carrying where it was going', () => {
    expect(
      signInRedirect({
        code: 'X_UNAUTHENTICATED',
        signInPath: '/signin',
        request: browser,
        ctx: at('/dashboard'),
      }),
    ).toEqual({ location: '/signin?next=%2Fdashboard', status: 303 });
  });

  test('the query string survives, so the retry lands on the same page', () => {
    expect(
      signInRedirect({
        code: 'X_UNAUTHENTICATED',
        signInPath: '/signin',
        request: browser,
        ctx: at('/messages', '?id=42'),
      })?.location,
    ).toBe('/signin?next=%2Fmessages%3Fid%3D42');
  });

  // The regression this whole module exists for: the deployed app answered a browser with
  // `{"type":"https://ultimate.dev/errors/X_UNAUTHENTICATED",…}` rendered as raw text.
  test('an agent still gets the problem document', () => {
    expect(
      signInRedirect({
        code: 'X_UNAUTHENTICATED',
        signInPath: '/signin',
        request: agent,
        ctx: at('/dashboard'),
      }),
    ).toBeUndefined();
  });

  test('off until an app declares where its sign-in page is', () => {
    expect(
      signInRedirect({
        code: 'X_UNAUTHENTICATED',
        signInPath: null,
        request: browser,
        ctx: at('/dashboard'),
      }),
    ).toBeUndefined();
  });

  test('any other failure is not a login wall', () => {
    expect(
      signInRedirect({
        code: 'X_FORBIDDEN',
        signInPath: '/signin',
        request: browser,
        ctx: at('/dashboard'),
      }),
    ).toBeUndefined();
  });

  // A sign-in page that declares `auth: 'required'` by mistake would redirect to itself, and the
  // browser reports that as "too many redirects" with no code and nothing to run.
  test('the sign-in page never redirects to itself', () => {
    expect(
      signInRedirect({
        code: 'X_UNAUTHENTICATED',
        signInPath: '/signin',
        request: browser,
        ctx: at('/signin'),
      }),
    ).toBeUndefined();
  });
});

// Every caller hands this the value a query or form parser ALREADY decoded once —
// `props.query.next`, an action's `next` input, `url.searchParams.get('next')`. So the fixtures
// below are decoded values, and a `%` in one is a literal `%` that belongs to the destination.
describe('unit · where a visitor lands after signing in', () => {
  test('back where they were going', () => {
    expect(nextAfterSignIn('/messages?id=42', '/dashboard')).toBe('/messages?id=42');
  });

  // `signInRedirect` encodes once, the query parser decodes once, and that is the whole round trip.
  // A second decode turned `?q=a%26b` into `?q=a&b` — a different query — and threw on `100%25done`.
  test.each([
    ['/search', '?q=a%26b'],
    ['/progress', '?label=100%25done'],
    ['/messages', '?id=42&tab=unread'],
    ['/files/a%2Fb', ''],
    ['/caf%C3%A9', '?q=%E6%97%A5'],
  ])(
    'signInRedirect → nextAfterSignIn round trip lands on the original path and query (%p%p)',
    (path, search) => {
      const intent = signInRedirect({
        code: 'X_UNAUTHENTICATED',
        signInPath: '/signin',
        request: browser,
        ctx: at(path, search),
      });
      const carried = new URL(intent?.location ?? '', 'https://app.test').searchParams.get('next');
      const landed = nextAfterSignIn(carried, '/dashboard');
      expect(landed).toBe(`${path}${search}`);
      // And it is a value a `Location` header can carry: a header that refuses it is a 500.
      expect(() => new Headers({ location: landed })).not.toThrow();
      // A sign-in page carries the answer in a hidden field and the action reads it back through
      // here: a second pass must be the identity, or the form post lands somewhere the GET did not.
      expect(nextAfterSignIn(landed, '/dashboard')).toBe(landed);
    },
  );

  test('nothing to return to falls back', () => {
    expect(nextAfterSignIn(null, '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn(undefined, '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('', '/dashboard')).toBe('/dashboard');
  });

  // `?next=` comes off the URL bar, so it is attacker-controlled. An unchecked value turns the
  // one page that holds a session into an open redirect — a real domain, a real login, a hop.
  test('an off-site destination is refused, in every spelling', () => {
    expect(nextAfterSignIn('https://evil.test/x', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('//evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('///evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('/\\evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('\\/evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('javascript:alert(1)', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('dashboard', '/dashboard')).toBe('/dashboard');
    // Still encoded (a caller that skipped its parser): not a path, so not a destination.
    expect(nextAfterSignIn('%2F%2Fevil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('%2F%5Cevil.test', '/dashboard')).toBe('/dashboard');
  });

  // Returned raw now, so a percent-encoded slash, backslash or control character reaches the
  // browser AS percent-encoding. A browser never decodes it before resolving a `Location`: each of
  // these is a path segment on this origin. Pinned by resolving it the way the browser will.
  test.each([
    '/%2F%2Fevil.test',
    '/%2F/evil.test',
    '/%5Cevil.test',
    '/%5C%5Cevil.test',
    '/%09/evil.test',
    '/%0A/evil.test',
  ])('the percent-encoded spelling %p stays a path on this origin', (raw) => {
    const landed = nextAfterSignIn(raw, '/dashboard');
    expect(new URL(landed, 'https://app.test').origin).toBe('https://app.test');
    expect(landed.startsWith('//')).toBe(false);
  });

  // A browser deletes tab/CR/LF from a `Location` before parsing it, so a single slash followed by
  // one of them is a scheme-relative URL wearing a disguise: `/\t/evil.test` is delivered, parsed
  // and followed as `//evil.test` → `https://evil.test`.
  test('a control character the URL parser strips cannot smuggle an origin past the check', () => {
    expect(nextAfterSignIn('/\t/evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('/\n/evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('/\r/evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('/\t\\evil.test', '/dashboard')).toBe('/dashboard');
  });

  // NUL and DEL are not stripped by the URL parser — a `Location` header refuses them outright,
  // which is a 500 on the sign-in page instead of a landing.
  test('any other control character falls back too', () => {
    expect(nextAfterSignIn('/a\u0000b', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('/a\u001bb', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('/a\u007fb', '/dashboard')).toBe('/dashboard');
  });

  // The value is off the URL bar, so it is not required to be valid percent-encoding either — and
  // it is not decoded, so a stray `%` is part of the destination rather than a reason to throw.
  test('a malformed encoding is not a decode error any more', () => {
    expect(nextAfterSignIn('%', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('/100%done', '/dashboard')).toBe('/100%done');
    expect(nextAfterSignIn('/a?b=%ZZ', '/dashboard')).toBe('/a?b=%ZZ');
  });

  // Normalised, because the check and the answer must be the SAME string: a raw value checked by
  // its resolution and returned unresolved let `/.//evil.test` pass as same-origin and reach the
  // router as `//evil.test`. Dot segments go; the query and fragment are kept byte for byte.
  test('an ordinary path is returned normalised, its query and fragment untouched', () => {
    expect(nextAfterSignIn('/a/../b', '/dashboard')).toBe('/b');
    expect(nextAfterSignIn('/a/./b/', '/dashboard')).toBe('/a/b/');
    expect(nextAfterSignIn('/messages?q=a%20b#top', '/dashboard')).toBe('/messages?q=a%20b#top');
  });

  // A `Location` is a ByteString: a code point above U+00FF is refused by `Headers`. The parser hands
  // `/café` over decoded, so the one rewrite made is percent-encoding exactly those code points.
  test('a non-ASCII destination is percent-encoded, never handed to a header raw', () => {
    expect(nextAfterSignIn('/日本?q=é', '/dashboard')).toBe('/%E6%97%A5%E6%9C%AC?q=%C3%A9');
    expect(nextAfterSignIn('/\uD800', '/dashboard')).toBe('/dashboard');
  });

  // Each resolves to a pathname starting `//` — a scheme-relative URL to anything that re-reads
  // it as a reference, which is what the client router does with `x-ultimate-location`.
  test.each([
    '/.//evil.test/phish',
    '/..//evil.test/phish',
    '/%2e//evil.test/phish',
    '/%2E%2E//evil.test/phish',
    '/a/..//evil.test/phish',
    '/./\\evil.test/phish',
    '/.\\/evil.test/phish',
  ])('a dot segment hiding a `//` (%p) falls back', (raw) => {
    expect(nextAfterSignIn(raw, '/dashboard')).toBe('/dashboard');
  });
});
