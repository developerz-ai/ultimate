import { describe, expect, test } from 'bun:test';
import { buildRobots, isIndexable } from './robots';

const BASE = { baseUrl: 'https://ultimate.dev' } as const;

/** Pin both keys for the duration of `fn`: an assertion gated on ambient env stops asserting. */
function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const original = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('isIndexable', () => {
  test('only production opts into indexing', () => {
    expect(isIndexable('production')).toBe(true);
    expect(isIndexable('staging')).toBe(false);
    expect(isIndexable('development')).toBe(false);
    expect(isIndexable('test')).toBe(false);
  });
});

describe('buildRobots', () => {
  test('a branch deploy disallows everything and advertises no sitemap', () => {
    const txt = buildRobots({ ...BASE, environment: 'staging', sitemaps: ['/sitemap.xml'] });
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Disallow: /');
    expect(txt).not.toContain('Allow: /');
    expect(txt).not.toContain('Sitemap:');
  });

  test('the unsafe default is impossible: omitting environment never allows all', () => {
    withEnv({ ULTIMATE_ENV: 'staging', NODE_ENV: 'production' }, () => {
      expect(buildRobots({ ...BASE, environment: undefined })).toContain('Disallow: /');
    });
  });

  test('a typo in ULTIMATE_ENV disallows rather than throwing out of the render', () => {
    // core's resolveEnvironment throws on this value; robots.txt must still answer, because
    // nothing in a web container's boot path resolves the environment first.
    withEnv({ ULTIMATE_ENV: 'prod', NODE_ENV: 'production' }, () => {
      const txt = buildRobots({ ...BASE, environment: undefined });
      expect(txt).toContain('Disallow: /');
      expect(txt).toContain('# environment: development');
    });
  });

  test('an unset ULTIMATE_ENV still reads NODE_ENV=production', () => {
    withEnv({ ULTIMATE_ENV: undefined, NODE_ENV: 'production' }, () => {
      expect(buildRobots({ ...BASE, environment: undefined })).toContain('Allow: /');
    });
  });

  test('production allows crawling and points at the sitemap', () => {
    const txt = buildRobots({
      ...BASE,
      environment: 'production',
      groups: [
        { userAgent: '*', allow: ['/'], disallow: ['/admin', '/api'] },
        { userAgent: 'GPTBot', disallow: ['/'] },
      ],
      sitemaps: ['/sitemap.xml'],
    });
    expect(txt).toContain('Disallow: /admin');
    expect(txt).toContain('User-agent: GPTBot');
    expect(txt).toContain('Sitemap: https://ultimate.dev/sitemap.xml');
    expect(txt.endsWith('\n')).toBe(true);
  });
});
