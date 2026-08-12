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

describe('unit · where a visitor lands after signing in', () => {
  test('back where they were going', () => {
    expect(nextAfterSignIn('%2Fmessages%3Fid%3D42', '/dashboard')).toBe('/messages?id=42');
  });

  test('nothing to return to falls back', () => {
    expect(nextAfterSignIn(null, '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('', '/dashboard')).toBe('/dashboard');
  });

  // `?next=` comes off the URL bar, so it is attacker-controlled. An unchecked value turns the
  // one page that holds a session into an open redirect — a real domain, a real login, a hop.
  test('an off-site destination is refused, in every spelling', () => {
    expect(nextAfterSignIn('https://evil.test/x', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('//evil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('%2F%5Cevil.test', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('javascript:alert(1)', '/dashboard')).toBe('/dashboard');
    expect(nextAfterSignIn('dashboard', '/dashboard')).toBe('/dashboard');
  });
});
