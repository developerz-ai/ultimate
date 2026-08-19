// The titles registered here are the first line of every pwa error a build sees — in the
// terminal, the dev overlay and `--json`. This proves the registry actually reflects what
// PWA_ERROR_TITLES declares, and that the one code this package borrows (`X_NOT_IMPLEMENTED`)
// is read back from the registry rather than re-declared here.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  PWA_BORROWED_ERROR_CODES,
  PWA_ERROR_CODES,
  PWA_ERROR_TITLES,
  PWA_OWNED_ERROR_CODES,
} from './errors';
import type { StrategyCache, StrategyEnv } from './strategies';
import { staleWhileRevalidate } from './strategies';

describe('PWA_ERROR_TITLES', () => {
  test('titles exactly the codes pwa owns — a borrowed code carries no title here', () => {
    expect(Object.keys(PWA_ERROR_TITLES).sort()).toEqual([...PWA_OWNED_ERROR_CODES].sort());
  });

  test('every title is a non-empty string', () => {
    for (const code of PWA_OWNED_ERROR_CODES) {
      expect(typeof PWA_ERROR_TITLES[code]).toBe('string');
      expect(PWA_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });

  test('owned and borrowed are disjoint and together are every code pwa throws', () => {
    const owned = new Set<string>(PWA_OWNED_ERROR_CODES);
    for (const code of PWA_BORROWED_ERROR_CODES) expect(owned.has(code)).toBe(false);
    expect([...PWA_ERROR_CODES].sort()).toEqual(
      [...PWA_OWNED_ERROR_CODES, ...PWA_BORROWED_ERROR_CODES].sort(),
    );
  });
});

describe('error code registry', () => {
  test('every pwa-owned code is registered with its declared title', () => {
    for (const code of PWA_OWNED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(PWA_ERROR_TITLES[code]);
    }
  });

  test('every pwa code documents at its own X_* url', () => {
    for (const code of PWA_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, read through the registry not through pwa', () => {
    expect(hasErrorCode('X_NOT_IMPLEMENTED')).toBe(true);
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
    expect(Object.keys(PWA_ERROR_TITLES)).not.toContain('X_NOT_IMPLEMENTED');
  });
});

/**
 * A caller can only `instanceof` what it can import. `X_PWA_STRATEGY_EXHAUSTED` is documented in
 * `wiki/Error-Codes.md` as raised by `staleWhileRevalidate`, which IS public API — so the class it
 * throws has to leave the package through `index.ts`, and it did not.
 *
 * The two `X_PWA_SYNC_*` classes deliberately stay internal: they title codes the emitted `sw.js`
 * throws in the service-worker realm, which has no bundler and constructs its own local class, so
 * no `instanceof` in an app can ever be true. Their codes and titles are public through
 * `PWA_ERROR_CODES` / `PWA_ERROR_TITLES`, which is the thing an app can actually use.
 */
describe('the public entry point', () => {
  test('exports the error class its own public API throws', async () => {
    const api: Record<string, unknown> = await import('./index');
    const cache: StrategyCache = {
      match: async (): Promise<undefined> => undefined,
      put: async (): Promise<void> => undefined,
    };
    const env: StrategyEnv = {
      open: async (): Promise<StrategyCache> => cache,
      fetch: async (): Promise<Response> => {
        throw new TypeError('network down');
      },
    };

    let thrown: unknown;
    try {
      await staleWhileRevalidate(new Request('https://app.test/x'), env, { cacheName: 'pages' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(api['PwaStrategyExhaustedError'] as new () => Error);
  });

  test('does not export the classes only the generated sw.js realm can throw', async () => {
    const api: Record<string, unknown> = await import('./index');
    expect(api['PwaSyncFlushFailedError']).toBeUndefined();
    expect(api['PwaSyncIncompleteError']).toBeUndefined();
    // Their codes are public even so — that is what an app matches on.
    expect(PWA_ERROR_CODES).toContain('X_PWA_SYNC_FLUSH_FAILED');
    expect(PWA_ERROR_CODES).toContain('X_PWA_SYNC_INCOMPLETE');
  });
});
