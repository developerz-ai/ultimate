// Pins `upgradeOrigin` directly: a declared origin list is the WHOLE list, so nothing a request
// says about itself can stand beside it — `sec-fetch-site` included. `x dev`'s reached-on origin
// is the one spelled exception. Status codes and the refusal's body: `sync-upgrade-origin.test.ts`.
import { describe, expect, test } from 'bun:test';
import { upgradeOrigin } from './sync-origin';

const DECLARED = ['https://app.example.com'];
const SIBLING = new URL('https://evil.example.com/_x/sync');
const REFUSED_BY_LIST = {
  ok: false,
  reason:
    'the origin it declares is not this app and is not listed in APP_URL or syncNode({ allowedOrigins })',
};

const dial = (url: URL, headers: Record<string, string>): Request => new Request(url, { headers });

describe('a declared list is the whole list', () => {
  test('a listed origin passes, with or without sec-fetch-site', () => {
    for (const site of [
      {},
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      const request = dial(SIBLING, { origin: 'https://app.example.com', ...site });
      expect(upgradeOrigin(request, SIBLING, DECLARED)).toEqual({ ok: true });
    }
  });

  // A browser says `same-origin` of a page truly served from the host it dialled, so this is a
  // sibling host pointed at the node, the case the empty `selfOrigins` closes, a `Domain=` cookie
  // riding. Its own verdict about that host is not evidence about the declared app.
  test.each(['same-origin', 'none'])('an unlisted origin saying %s is refused', (site) => {
    const request = dial(SIBLING, { origin: SIBLING.origin, 'sec-fetch-site': site });
    expect(upgradeOrigin(request, SIBLING, DECLARED)).toEqual(REFUSED_BY_LIST);
  });

  test('an unlisted origin saying nothing is refused for the same reason', () => {
    const request = dial(SIBLING, { origin: SIBLING.origin });
    expect(upgradeOrigin(request, SIBLING, DECLARED)).toEqual(REFUSED_BY_LIST);
  });
});

describe('nothing declared', () => {
  test('the browser’s same-origin verdict still stands', () => {
    const url = new URL('http://app.example.com/_x/sync');
    const request = dial(url, {
      origin: 'https://app.example.com',
      'sec-fetch-site': 'same-origin',
    });
    expect(upgradeOrigin(request, url, [])).toEqual({ ok: true });
  });

  test('a foreign origin saying cross-site is refused', () => {
    const url = new URL('https://app.example.com/_x/sync');
    const request = dial(url, { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' });
    expect(upgradeOrigin(request, url, []).ok).toBe(false);
  });
});

describe('x dev keeps the reached-on origin beside a declaration', () => {
  const reached = new URL('http://localhost:4000/_x/sync');

  test('the reached-on origin passes, with and without the header', () => {
    for (const site of [{}, { 'sec-fetch-site': 'same-origin' }]) {
      const request = dial(reached, { origin: reached.origin, ...site });
      expect(upgradeOrigin(request, reached, DECLARED, true)).toEqual({ ok: true });
    }
  });

  test('the browser’s same-origin verdict is still taken there: the list is not whole', () => {
    const forwarded = new URL('http://forward.test:4000/_x/sync');
    const request = dial(forwarded, {
      origin: 'http://elsewhere.test',
      'sec-fetch-site': 'same-origin',
    });
    expect(upgradeOrigin(request, forwarded, DECLARED, true)).toEqual({ ok: true });
  });

  test('a foreign origin saying nothing is refused', () => {
    const request = dial(reached, { origin: 'https://evil.test' });
    expect(upgradeOrigin(request, reached, DECLARED, true).ok).toBe(false);
  });
});

// `APP_URL=app.example.com:3000` parses: the scheme is `app.example.com:`, and the origin of a
// non-special URL is the STRING `null` — which is what every sandboxed iframe on the web sends.
describe('a declared entry with no real origin admits nobody', () => {
  test.each(['app.example.com:3000', 'localhost:3000', 'file:///srv/app'])(
    '%s does not admit Origin: null',
    (declared) => {
      const request = dial(SIBLING, { origin: 'null' });
      expect(upgradeOrigin(request, SIBLING, [declared]).ok).toBe(false);
    },
  );
});
