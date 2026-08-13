import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError, type UltimateError } from './errors';

describe('defineConfig', () => {
  test('fills every section with defaults from a one-line config', () => {
    const config = defineConfig({ name: 'myapp' });

    expect(config.defaultLocale).toBe('en');
    expect(config.defaultTimeZone).toBe('UTC');
    expect(config.defaultCurrency).toBe('USD');
    expect(config.theme.defaultMode).toBe('system');
    expect(config.pwa.enabled).toBe(false);
    expect(config.database).toEqual({
      driver: 'postgres',
      urlEnv: 'DATABASE_URL',
      poolSize: 10,
      ssl: false,
      schema: 'public',
      jitPreload: true,
    });
    expect(config.jobs.queues).toEqual(['myapp-default']);
    expect(config.ai.mcp).toEqual({ expose: true, path: '/mcp' });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('overlays let config/ split by concern, last one wins', () => {
    const config = defineConfig(
      { name: 'myapp', locales: ['en', 'es'], defaultLocale: 'es' },
      { jobs: { driver: 'redis', concurrency: 32 } },
      { realtime: { enabled: true, tier: 'live-queries', transport: 'nats', urlEnv: 'NATS_URL' } },
    );

    expect(config.jobs.driver).toBe('redis');
    expect(config.jobs.concurrency).toBe(32);
    // untouched keys still come from defaults
    expect(config.jobs.maxAttempts).toBe(5);
    expect(config.realtime.tier).toBe('live-queries');
    expect(config.defaultLocale).toBe('es');
  });

  test('collects every problem into one X_CONFIG_INVALID', () => {
    let caught: unknown;
    try {
      defineConfig({
        name: 'My App',
        locales: ['en'],
        defaultLocale: 'de',
        defaultTimeZone: 'Mars/Olympus',
        defaultCurrency: 'usd',
      });
    } catch (thrown) {
      caught = thrown;
    }

    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).toContain('name "My App"');
    expect(error.cause).toContain('defaultLocale "de" is not in locales');
    expect(error.cause).toContain('is not an IANA time zone');
    expect(error.cause).toContain('is not a 3-letter ISO 4217 code');
    expect(error.fix).toContain('x verify');
  });

  test('a non-memory transport without a url env is a config error, not a runtime crash', () => {
    const causeOf = (input: () => void): string => {
      try {
        input();
      } catch (thrown) {
        return (thrown as UltimateError).cause;
      }
      throw new Error('expected defineConfig to throw');
    };

    const realtime = causeOf(() =>
      defineConfig({ name: 'myapp', realtime: { transport: 'nats' } }),
    );
    expect(realtime).toContain('realtime.urlEnv');
    expect(causeOf(() => defineConfig({ name: 'myapp', cache: { driver: 'redis' } }))).toContain(
      'cache.urlEnv',
    );
  });
});
