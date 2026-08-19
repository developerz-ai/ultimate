// The constructors' PROSE, which nothing else asserts on. A cause is the first thing an operator
// reads, so a stray character in it is a shipped defect even though no code path branches on it.

import { describe, expect, test } from 'bun:test';
import { driverUnknown } from './error-throws';

describe('unit · X_SCRAPE_DRIVER_UNKNOWN reads as a sentence', () => {
  test('the no-driver-at-all cause has no dangling punctuation', () => {
    const error = driverUnknown(undefined, [], 'orders.daily');
    expect(error.code).toBe('X_SCRAPE_DRIVER_UNKNOWN');
    expect(error.cause).toBe(
      'scrape "orders.daily" has no browser driver: nothing called setScrapeDriver() and the definition declares no driver; installed: none',
    );
  });

  test('the installed list is still named, and the scrape is not called a driver', () => {
    const error = driverUnknown(undefined, ['puppeteer', 'fixture'], 'orders.daily');
    expect(error.cause).toContain('installed: puppeteer, fixture');
    expect(error.cause).not.toContain('driver named "orders.daily"');
    expect(error.meta).toEqual({ driver: 'none', scrape: 'orders.daily' });
  });

  test('a named-but-missing driver keeps its own cause', () => {
    const error = driverUnknown('playwright', ['puppeteer']);
    expect(error.cause).toBe(
      'no scrape driver named "playwright" is installed; installed: puppeteer',
    );
  });
});
