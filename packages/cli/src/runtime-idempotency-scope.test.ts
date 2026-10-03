// A container that ends its boot over a per-process idempotency store says so: nothing else can,
// because `assertIdempotencyScope` checks a 'shared' DECLARATION and the default declares nothing.

import { afterEach, describe, expect, test } from 'bun:test';
import type { IdempotencyStore } from '@ultimat3/action';
import { MemoryIdempotencyStore, postgresIdempotencyStore } from '@ultimat3/action';
import { logger } from '@ultimat3/core';
import { warnIfIdempotencyProcessScoped } from './runtime-idempotency-scope';

const printWarning = logger.warn;
const warned: string[] = [];

afterEach(() => {
  logger.warn = printWarning;
  warned.length = 0;
});

describe('unit · the idempotency store a container boot ends with', () => {
  test('a per-process store is warned about, with the declaration that turns it into a refusal', () => {
    logger.warn = (message: string, fields?: Record<string, unknown>) => {
      warned.push(`${message} ${String(fields?.['fix'])}`);
    };
    expect(warnIfIdempotencyProcessScoped(new MemoryIdempotencyStore())).toBe(true);
    expect(warned).toEqual(["X_CONFIG_INVALID configureIdempotency({ scope: 'shared' })"]);
  });

  test('the shared store the boot installs says nothing', () => {
    logger.warn = (message: string) => {
      warned.push(message);
    };
    const shared: IdempotencyStore = postgresIdempotencyStore({
      executor: { query: async () => [] },
      origin: () => ({}),
      reclaimAfterMs: () => 30_000,
    });
    expect(warnIfIdempotencyProcessScoped(shared)).toBe(false);
    expect(warned).toEqual([]);
  });
});
