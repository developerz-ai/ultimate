// A cache error is worth exactly what its instruction is worth: the code an agent branches on
// and the command it can run next. Both are prose the compiler cannot check, so they rot unless
// something asserts them — these tests are that something.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  CACHE_ERROR_CODES,
  CACHE_ERROR_TITLES,
  CacheDriverUnavailableError,
  CacheNotImplementedError,
  CacheTagUnknownError,
  CacheTooLargeError,
} from './errors';

describe('CACHE_ERROR_CODES', () => {
  test('every code is distinct', () => {
    expect(new Set(CACHE_ERROR_CODES).size).toBe(CACHE_ERROR_CODES.length);
  });
});

describe('CacheDriverUnavailableError', () => {
  test('embeds driver and cause, keeps the given fix, and uses a registered code', () => {
    const err = new CacheDriverUnavailableError({
      driver: 'redis',
      cause: 'ECONNREFUSED',
      fix: 'start redis or set CACHE_REDIS_URL',
    });

    expect(err.code).toBe('X_CACHE_DRIVER_UNAVAILABLE');
    expect(err.cause).toContain('redis');
    expect(err.cause).toContain('ECONNREFUSED');
    expect(err.fix).toBe('start redis or set CACHE_REDIS_URL');
    expect(err.docs).toBe('https://ultimate.dev/errors/X_CACHE_DRIVER_UNAVAILABLE');
    expect(CACHE_ERROR_CODES).toContain(err.code);
  });
});

describe('CacheTagUnknownError', () => {
  test('reports "known: none" when nothing is declared', () => {
    const err = new CacheTagUnknownError({ tag: 'pots', known: [] });

    expect(err.code).toBe('X_CACHE_TAG_UNKNOWN');
    expect(err.cause).toContain('"pots"');
    expect(err.cause).toContain('declared: none');
    expect(CACHE_ERROR_CODES).toContain(err.code);
  });

  test('joins declared tags with ", " when some are known', () => {
    const err = new CacheTagUnknownError({ tag: 'pots', known: ['post', 'user'] });

    expect(err.cause).toContain('declared: post, user');
  });
});

describe('CacheTooLargeError', () => {
  test('embeds key, bytes, tier and maxBytes', () => {
    const err = new CacheTooLargeError({
      key: 'post:1',
      bytes: 5_000,
      tier: 'lru',
      maxBytes: 1_000,
    });

    expect(err.code).toBe('X_CACHE_TOO_LARGE');
    expect(err.cause).toContain('post:1');
    expect(err.cause).toContain('5000');
    expect(err.cause).toContain('lru');
    expect(err.cause).toContain('1000');
    expect(CACHE_ERROR_CODES).toContain(err.code);
  });
});

describe('CacheNotImplementedError', () => {
  test('embeds the missing feature', () => {
    const err = new CacheNotImplementedError({
      feature: 'redis cluster mode',
      fix: 'use a single-node redis client until clustering lands',
    });

    expect(err.code).toBe('X_NOT_IMPLEMENTED');
    expect(err.cause).toContain('redis cluster mode');
    expect(err.fix).toBe('use a single-node redis client until clustering lands');
    expect(CACHE_ERROR_CODES).toContain(err.code);
  });
});

describe('CACHE_ERROR_TITLES', () => {
  test('has exactly one title per declared code, and no extras', () => {
    const titled = Object.keys(CACHE_ERROR_TITLES).sort();
    const declared = [...CACHE_ERROR_CODES].sort();
    expect(titled).toEqual(declared);
  });
});

describe('registration', () => {
  test('every declared code is registered in the framework-wide registry', () => {
    for (const code of CACHE_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('describeErrorCode renders the title this package declared', () => {
    for (const code of CACHE_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(CACHE_ERROR_TITLES[code]);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not re-registered by cache', () => {
    // cache/src/errors.ts guards this code with hasErrorCode() and never calls
    // registerErrorCodes() for it, so the title rendered here is core's — this pins that
    // fact instead of letting the loop above pass on a coincidence.
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
  });
});

describe('docs', () => {
  test('every code resolves to its canonical docs page', () => {
    for (const code of CACHE_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
