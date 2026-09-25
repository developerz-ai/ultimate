// The `site` and `seo` sections: defaults, overlay merge, and the refusals `defineConfig` raises.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

const causeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (!isUltimateError(error)) return expect.unreachable('defineConfig threw its own error');
    return error.cause;
  }
  return expect.unreachable('expected X_CONFIG_INVALID, nothing was thrown');
};

describe('site and seo — refusals', () => {
  test('an origin with a path, a non-http scheme or no scheme is refused', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', site: { origin: 'https://x.co/app' } })),
    ).toContain('origin only');
    expect(causeOf(() => defineConfig({ name: 'app', site: { origin: 'ftp://x.co' } }))).toContain(
      'http:// or https://',
    );
    expect(causeOf(() => defineConfig({ name: 'app', site: { origin: 'x.co' } }))).toContain(
      'not an absolute URL',
    );
  });

  test('a disallow path that does not start with / is refused', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', seo: { robots: { disallow: ['panel'] } } })),
    ).toContain('must start with /');
  });
});

describe('site and seo', () => {
  test('defaults: no origin, nothing disallowed', () => {
    const config = defineConfig({ name: 'app' });
    expect(config.site).toEqual({ origin: null });
    expect(config.seo).toEqual({ robots: { disallow: [] } });
  });

  test('an overlay patches one section without dropping the other', () => {
    const config = defineConfig(
      { name: 'app', site: { origin: 'https://notificado.co' } },
      { seo: { robots: { disallow: ['/panel'] } } },
    );
    expect(config.site.origin).toBe('https://notificado.co');
    expect(config.seo.robots.disallow).toEqual(['/panel']);
  });
});
