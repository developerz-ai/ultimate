import { describe, expect, test } from 'bun:test';
import { buildRobots, isIndexable, resolveEnvironment } from './robots';

const BASE = { baseUrl: 'https://ultimate.dev' } as const;

describe('resolveEnvironment', () => {
  test('only the exact string "production" opts into indexing', () => {
    expect(resolveEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(resolveEnvironment({ NODE_ENV: 'Production' })).toBe('preview');
    expect(resolveEnvironment({})).toBe('preview');
    expect(resolveEnvironment({ ULTIMATE_ENV: 'staging' })).toBe('preview');
    expect(isIndexable('preview')).toBe(false);
  });

  test('ULTIMATE_ENV wins over NODE_ENV', () => {
    expect(resolveEnvironment({ ULTIMATE_ENV: 'preview', NODE_ENV: 'production' })).toBe('preview');
  });
});

describe('buildRobots', () => {
  test('a preview deploy disallows everything and advertises no sitemap', () => {
    const txt = buildRobots({ ...BASE, environment: 'preview', sitemaps: ['/sitemap.xml'] });
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Disallow: /');
    expect(txt).not.toContain('Allow: /');
    expect(txt).not.toContain('Sitemap:');
  });

  test('the unsafe default is impossible: omitting environment never allows all', () => {
    // buildRobots resolves the environment from process.env when omitted, so pin
    // both vars for the duration of this test instead of guessing at ambient state —
    // an assertion gated on the ambient env can silently stop asserting anything.
    const originalUltimateEnv = process.env.ULTIMATE_ENV;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.ULTIMATE_ENV = 'preview';
    process.env.NODE_ENV = 'preview';
    try {
      expect(resolveEnvironment()).toBe('preview');
      const txt = buildRobots({ ...BASE, environment: undefined });
      expect(txt.includes('Disallow: /') || txt.includes('Sitemap:')).toBe(true);
      expect(txt).toContain('Disallow: /');
    } finally {
      if (originalUltimateEnv === undefined) delete process.env.ULTIMATE_ENV;
      else process.env.ULTIMATE_ENV = originalUltimateEnv;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
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
