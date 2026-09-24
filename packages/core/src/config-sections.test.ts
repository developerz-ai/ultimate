// Single responsibility: how overlays merge per section (key by key, never section by section),
// the numeric domain every config count and window must sit in, and the `drain` section's default.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (!isUltimateError(error)) return expect.unreachable('defineConfig threw its own error');
    expect(error.code).toBe('X_CONFIG_INVALID');
    return error.cause;
  }
  return expect.unreachable('expected X_CONFIG_INVALID, nothing was thrown');
};

describe('overlays merge key by key', () => {
  test('an overlay patching one jobs key keeps the base config’s other jobs keys', () => {
    // `Object.assign` over the whole input replaced the section: `{ jobs: { maxAttempts: 9 } }`
    // reset the base's `queues` and `concurrency` to the framework defaults.
    const config = defineConfig(
      { name: 'app', jobs: { queues: ['mail', 'billing'], concurrency: 3 } },
      { jobs: { maxAttempts: 9 } },
    );
    expect(config.jobs.queues).toEqual(['mail', 'billing']);
    expect(config.jobs.concurrency).toBe(3);
    expect(config.jobs.maxAttempts).toBe(9);
  });

  test('an overlay section set to undefined changes nothing', () => {
    const config = defineConfig(
      { name: 'app', realtime: { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' } },
      { realtime: undefined, locales: undefined },
    );
    expect(config.realtime).toEqual({ enabled: true, transport: 'nats', urlEnv: 'NATS_URL' });
    expect(config.locales).toEqual(['en']);
  });

  test('nested sections merge per layer too: pwa.offline and ai.mcp', () => {
    const config = defineConfig(
      { name: 'app', pwa: { offline: { fallback: '/offline' } }, ai: { mcp: { path: '/agents' } } },
      { pwa: { offline: { neverCache: ['/api'] } }, ai: { mcp: { expose: false } } },
    );
    expect(config.pwa.offline.fallback).toBe('/offline');
    expect(config.pwa.offline.neverCache).toEqual(['/api']);
    expect(config.ai.mcp).toEqual({ expose: false, path: '/agents' });
  });

  test('later layers still win, and an overlay may not rename the app', () => {
    const config = defineConfig(
      { name: 'app', jobs: { concurrency: 2 } },
      { jobs: { concurrency: 4 }, name: 'renamed' },
      { jobs: { concurrency: 6 } },
    );
    expect(config.jobs.concurrency).toBe(6);
    expect(config.name).toBe('app');
  });
});

describe('every numeric key is screened', () => {
  const cases: readonly [string, Record<string, unknown>, unknown][] = [
    ['jobs.concurrency', { jobs: { concurrency: Number.NaN } }, Number.NaN],
    ['jobs.concurrency', { jobs: { concurrency: 2.5 } }, 2.5],
    ['jobs.concurrency', { jobs: { concurrency: Number.POSITIVE_INFINITY } }, 'Infinity'],
    ['jobs.concurrency', { jobs: { concurrency: 0 } }, 0],
    ['jobs.maxAttempts', { jobs: { maxAttempts: -3 } }, -3],
    ['jobs.maxAttempts', { jobs: { maxAttempts: 0 } }, 0],
    ['jobs.visibilityTimeoutMs', { jobs: { visibilityTimeoutMs: Number.NaN } }, Number.NaN],
    ['jobs.visibilityTimeoutMs', { jobs: { visibilityTimeoutMs: 0 } }, 0],
    ['cache.defaultTtlMs', { cache: { defaultTtlMs: -1 } }, -1],
    ['cache.defaultTtlMs', { cache: { defaultTtlMs: 1.5 } }, 1.5],
    ['cache.defaultTtlMs', { cache: { defaultTtlMs: '60s' } }, '60s'],
  ];
  test.each(cases)('%s refuses %p', (key, patch) => {
    const cause = refusal(() => defineConfig({ name: 'app', ...patch }));
    expect(cause).toContain(key);
  });

  test('the defaults, and the edges of each domain, are accepted', () => {
    expect(() =>
      defineConfig({
        name: 'app',
        jobs: { concurrency: 1, maxAttempts: 1, visibilityTimeoutMs: 1 },
        cache: { defaultTtlMs: 0 },
      }),
    ).not.toThrow();
  });
});

describe('drain.readinessGraceMs', () => {
  const saved = { ULTIMATE_ENV: process.env['ULTIMATE_ENV'], NODE_ENV: process.env['NODE_ENV'] };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('no environment at all yields the production grace, 5000', () => {
    delete process.env['ULTIMATE_ENV'];
    delete process.env['NODE_ENV'];
    expect(defineConfig({ name: 'app' }).drain.readinessGraceMs).toBe(5000);
  });

  test('a local environment yields no grace', () => {
    delete process.env['ULTIMATE_ENV'];
    process.env['NODE_ENV'] = 'development';
    expect(defineConfig({ name: 'app' }).drain.readinessGraceMs).toBe(0);
  });

  test('0 is accepted — no grace — and an explicit value wins over the default', () => {
    expect(
      defineConfig({ name: 'app', drain: { readinessGraceMs: 0 } }).drain.readinessGraceMs,
    ).toBe(0);
    expect(
      defineConfig({ name: 'app', drain: { readinessGraceMs: 12_000 } }).drain.readinessGraceMs,
    ).toBe(12_000);
  });

  test.each([Number.NaN, -1, 1.5, 60_001])('%p is refused, naming the key', (value) => {
    const cause = refusal(() => defineConfig({ name: 'app', drain: { readinessGraceMs: value } }));
    expect(cause).toContain('drain.readinessGraceMs');
  });
});
