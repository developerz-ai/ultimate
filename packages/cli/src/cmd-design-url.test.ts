import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  browserDialScreen,
  designHostPolicy,
  followTargets,
  readDesignAllowHosts,
  readReferenceUrl,
  screenReference,
} from './cmd-design-url';

const codeOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    throw error;
  }
  return expect.unreachable('the URL was accepted');
};

/** A sealed resolver: `inward.test` answers a private address, everything else a public one. */
const resolve = async (host: string): Promise<readonly string[]> =>
  host === 'inward.test' ? ['10.0.0.7'] : ['93.184.216.34'];

describe('readReferenceUrl', () => {
  test('an http(s) URL is kept as typed', () => {
    expect(readReferenceUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  test('another scheme, credentials, or no URL at all is X_DESIGN_URL_REFUSED', async () => {
    for (const raw of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://u:p@example.com/',
      'example',
    ]) {
      expect(await codeOf(() => readReferenceUrl(raw))).toBe('X_DESIGN_URL_REFUSED');
    }
  });
});

describe('screenReference', () => {
  const policy = designHostPolicy({ resolve });

  test('loopback, private, link-local and localhost are refused before any browser', async () => {
    for (const url of [
      'http://127.0.0.1:3000/',
      'http://localhost/',
      'http://10.1.2.3/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://inward.test/',
    ]) {
      expect(await codeOf(() => screenReference(url, policy))).toBe('X_DESIGN_URL_REFUSED');
    }
  });

  test('a public name passes', async () => {
    await screenReference('https://example.com/', policy);
  });

  test('a harness-trusted host passes, by exact name only', async () => {
    const trusted = designHostPolicy({ resolve, trustedHosts: ['127.0.0.1'] });
    await screenReference('http://127.0.0.1:4000/', trusted);
    expect(await codeOf(() => screenReference('http://localhost:4000/', trusted))).toBe(
      'X_DESIGN_URL_REFUSED',
    );
  });
});

describe('browserDialScreen', () => {
  test('a name resolving inward is refused, a public one released, a literal left to the floor', async () => {
    const screen = browserDialScreen(designHostPolicy({ resolve }));
    expect(await screen('http://inward.test/x.png')).toBe(true);
    expect(await screen('https://cdn.example.com/a.css')).toBe(false);
    expect(screen('http://10.0.0.1/')).toBeUndefined();
    expect(screen('data:text/plain,hi')).toBeUndefined();
  });

  test('resolves each name once per session', async () => {
    let asked = 0;
    const screen = browserDialScreen(
      designHostPolicy({
        resolve: async (host) => {
          asked += 1;
          return resolve(host);
        },
      }),
    );
    await screen('https://cdn.example.com/a.css');
    await screen('https://cdn.example.com/b.css');
    expect(asked).toBe(1);
  });
});

describe('readDesignAllowHosts', () => {
  test('names public hosts; an inward literal, localhost or * is refused', async () => {
    expect(readDesignAllowHosts('docs.example.com, *.example.org')).toEqual([
      'docs.example.com',
      '*.example.org',
    ]);
    for (const raw of ['127.0.0.1', 'localhost', '*', '10.0.0.1', 'a.com,,b.com']) {
      expect(await codeOf(() => readDesignAllowHosts(raw))).toMatch(
        /^X_(DESIGN_URL_REFUSED|CLI_BAD_FLAG)$/,
      );
    }
  });
});

describe('followTargets', () => {
  const links = [
    'https://example.com/a',
    'https://example.com/a#top',
    'https://example.com/b',
    'https://other.com/c',
    'https://docs.example.org/d',
    'mailto:x@example.com',
    'https://example.com/',
  ];

  test('same-origin links, deduped without their fragment, never the page itself, at most n', () => {
    expect(followTargets('https://example.com/', links, [], 5)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(followTargets('https://example.com/', links, [], 1)).toEqual(['https://example.com/a']);
    expect(followTargets('https://example.com/', links, [], 0)).toEqual([]);
  });

  test('--allow-hosts widens which hosts may be followed', () => {
    expect(followTargets('https://example.com/', links, ['*.example.org'], 5)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://docs.example.org/d',
    ]);
  });
});
