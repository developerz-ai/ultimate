// A cache error is worth exactly what its instruction is worth: the code an agent branches on
// and the command it can run next. Both are prose the compiler cannot check, so they rot unless
// something asserts them — these tests are that something.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  describeErrorCode,
  errorCodeSnapshot,
  hasErrorCode,
  registerErrorCodes,
  resetErrorCodes,
} from '@ultimat3/core';
import {
  CACHE_BORROWED_ERROR_CODES,
  CACHE_ERROR_CODES,
  CACHE_ERROR_TITLES,
  CACHE_OWNED_ERROR_CODES,
  CacheDriverUnavailableError,
  CacheNotImplementedError,
  CacheTagUnknownError,
  CacheTooLargeError,
} from './errors';

// The registry is process-global and every package fills it once, at import time. The collision
// test below resets it, so the snapshot taken here is what hands every other package its titles
// back — without it this file would strip them for the rest of the run.
const restoreRegistry = errorCodeSnapshot();

afterAll(restoreRegistry);

/** Widened once: `toContain` compares against a thrown `error.code`, which is a plain string. */
const EVERY_CODE: readonly string[] = CACHE_ERROR_CODES;

/** The exact declarations `errors.ts` registers at import, rebuilt. */
const cacheDeclarations = (): Record<string, { title: string }> =>
  Object.fromEntries(Object.entries(CACHE_ERROR_TITLES).map(([code, title]) => [code, { title }]));

describe('CACHE_ERROR_CODES', () => {
  test('every code is distinct', () => {
    expect(new Set(CACHE_ERROR_CODES).size).toBe(CACHE_ERROR_CODES.length);
  });

  test('owned and borrowed are disjoint and together are every code cache throws', () => {
    const owned = new Set<string>(CACHE_OWNED_ERROR_CODES);
    for (const code of CACHE_BORROWED_ERROR_CODES) expect(owned.has(code)).toBe(false);
    expect([...CACHE_ERROR_CODES].sort()).toEqual(
      [...CACHE_OWNED_ERROR_CODES, ...CACHE_BORROWED_ERROR_CODES].sort(),
    );
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
    expect(EVERY_CODE).toContain(err.code);
  });
});

describe('CacheTagUnknownError', () => {
  test('reports "known: none" when nothing is declared', () => {
    const err = new CacheTagUnknownError({ tag: 'pots', known: [] });

    expect(err.code).toBe('X_CACHE_TAG_UNKNOWN');
    expect(err.cause).toContain('"pots"');
    expect(err.cause).toContain('declared: none');
    expect(EVERY_CODE).toContain(err.code);
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
    expect(EVERY_CODE).toContain(err.code);
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
    expect(EVERY_CODE).toContain(err.code);
  });
});

describe('CACHE_ERROR_TITLES', () => {
  test('titles exactly the codes cache owns — a borrowed code carries no title here', () => {
    expect(Object.keys(CACHE_ERROR_TITLES).sort()).toEqual([...CACHE_OWNED_ERROR_CODES].sort());
  });
});

describe('registration', () => {
  test('every declared code is registered in the framework-wide registry', () => {
    for (const code of CACHE_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('describeErrorCode renders the title this package declared', () => {
    for (const code of CACHE_OWNED_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(CACHE_ERROR_TITLES[code]);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not re-registered by cache', () => {
    // cache declares no title for it, so the string below can only have come from core.
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
  });

  // The regression this file exists for. Behind a `hasErrorCode()` guard, a foreign package that
  // claimed a cache-OWNED code first kept its own title and nothing failed — so what a code meant
  // came down to import order. Registering unconditionally is what makes that collision loud.
  test('a foreign claim on a cache-owned code throws instead of silently keeping its title', () => {
    const restore = errorCodeSnapshot();
    try {
      resetErrorCodes();
      registerErrorCodes({ X_CACHE_TAG_UNKNOWN: { title: 'another package got here first' } });

      expect(() => {
        registerErrorCodes(cacheDeclarations());
      }).toThrow(/X_ERROR_CODE_DUPLICATE/);

      // The foreign title is still what the registry holds: the throw is the only thing between
      // a collision and two packages shipping two meanings for one code.
      expect(describeErrorCode('X_CACHE_TAG_UNKNOWN').title).toBe('another package got here first');
    } finally {
      restore();
    }
  });

  test('the registration cache does at import is itself rejected a second time', () => {
    expect(() => {
      registerErrorCodes(cacheDeclarations());
    }).toThrow(/X_ERROR_CODE_DUPLICATE/);
    expect(describeErrorCode('X_CACHE_TAG_UNKNOWN').title).toBe(
      CACHE_ERROR_TITLES.X_CACHE_TAG_UNKNOWN,
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
