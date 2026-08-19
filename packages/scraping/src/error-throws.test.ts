// The constructors' PROSE, which nothing else asserts on. A cause is the first thing an operator
// reads, so a stray character in it is a shipped defect even though no code path branches on it.

import { describe, expect, test } from 'bun:test';
import {
  browserUnreachable,
  cdpAttachFailed,
  driverUnknown,
  fixtureStale,
  notActionable,
  profileLocked,
  promptUnanswered,
  remoteRequired,
  scrapeTimeout,
  sessionExpired,
} from './error-throws';

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

describe('unit · a thrown value from somebody else`s library is RENDERED, never interpolated', () => {
  test('an Error keeps its message', () => {
    const error = cdpAttachFailed(
      'ws://chrome:9222/devtools/browser/abc',
      new Error('ECONNREFUSED'),
    );
    expect(error.code).toBe('X_SCRAPE_CDP_ATTACH_FAILED');
    expect(error.cause).toBe(
      'the CDP endpoint ws://chrome:9222/devtools/browser/abc refused the attach: Error: ECONNREFUSED',
    );
    expect(error.meta).toEqual({ cdpUrl: 'ws://chrome:9222/devtools/browser/abc' });
  });

  test('a non-Error throw still produces a readable cause rather than [object Object]', () => {
    // `${x}` on a null-prototype object throws, and this cause is built while handling a failure —
    // a second throw there would replace the browser's error with a TypeError from this file.
    const hostile = Object.assign(Object.create(null), { detail: 'socket hang up' }) as unknown;
    const error = browserUnreachable('puppeteer', hostile);
    expect(error.cause).toStartWith('the puppeteer browser stopped answering: ');
    expect(error.cause).not.toContain('[object Object]');
  });
});

describe('unit · the fix line is an executable command, per code', () => {
  test('X_SCRAPE_PROFILE_LOCKED names the lock file to remove, not the directory alone', () => {
    const error = profileLocked('/var/scrape/profiles/org-1');
    expect(error.code).toBe('X_SCRAPE_PROFILE_LOCKED');
    expect(error.cause).toBe(
      'another browser process holds the profile at /var/scrape/profiles/org-1',
    );
    expect(error.fix).toContain('rm -f /var/scrape/profiles/org-1/SingletonLock');
  });

  test('X_SCRAPE_NOT_ACTIONABLE says what was wrong AND how long it waited', () => {
    const error = notActionable('#submit', 'covered by another element', 5_000);
    expect(error.code).toBe('X_SCRAPE_NOT_ACTIONABLE');
    expect(error.cause).toBe('"#submit" is present and covered by another element after 5000ms');
    expect(error.meta).toEqual({
      selector: '#submit',
      reason: 'covered by another element',
      waitedMs: 5_000,
    });
  });

  test('X_SCRAPE_FIXTURE_STALE reports both ages in DAYS, rounded', () => {
    // Milliseconds are unreadable at this scale and the maxAge the author wrote was in days.
    const error = fixtureStale('https://shop.test/orders', 8.4 * 86_400_000, 7 * 86_400_000);
    expect(error.code).toBe('X_SCRAPE_FIXTURE_STALE');
    expect(error.cause).toBe(
      'the recording of https://shop.test/orders is 8 days old and fixtureBrowser declares maxAge 7 days',
    );
    expect(error.meta).toMatchObject({ url: 'https://shop.test/orders' });
  });

  test('X_SCRAPE_REMOTE_REQUIRED names the driver that needed a cdpUrl', () => {
    const error = remoteRequired('puppeteer');
    expect(error.code).toBe('X_SCRAPE_REMOTE_REQUIRED');
    expect(error.cause).toContain(
      'the puppeteer driver attaches to a browser somebody else started',
    );
    expect(error.fix).toContain('remoteBrowser({ cdpUrl: env.SCRAPE_CDP_URL })');
  });

  test('X_SCRAPE_PROMPT_UNANSWERED quotes the label the site asked for', () => {
    const error = promptUnanswered('orders.daily', 'SMS code');
    expect(error.code).toBe('X_SCRAPE_PROMPT_UNANSWERED');
    expect(error.cause).toBe(
      'scrape "orders.daily" asked for "SMS code" and no prompt handler was declared',
    );
    expect(error.fix).toContain(
      'add prompt: async ({ label }) => await otpFor(label) to scrape("orders.daily")',
    );
    expect(error.meta).toEqual({ scrape: 'orders.daily', label: 'SMS code' });
  });
});

describe('unit · the two budget/session failures', () => {
  test('X_SCRAPE_TIMEOUT names WHAT ran out and the budget it had', () => {
    const error = scrapeTimeout('goto https://shop.test/orders', 30_000);
    expect(error.code).toBe('X_SCRAPE_TIMEOUT');
    expect(error.cause).toBe('goto https://shop.test/orders exceeded its 30000ms budget');
    expect(error.meta).toEqual({ what: 'goto https://shop.test/orders', ms: 30_000 });
  });

  test('X_SCRAPE_SESSION_EXPIRED names the session key and the missing auth.login', () => {
    const error = sessionExpired('orders.daily', 'org-1/orders.daily/default');
    expect(error.code).toBe('X_SCRAPE_SESSION_EXPIRED');
    expect(error.cause).toContain('the stored session org-1/orders.daily/default');
    expect(error.cause).toContain('declares no auth.login');
    expect(error.fix).toContain('add auth: { login } to scrape("orders.daily")');
    expect(error.meta).toEqual({ scrape: 'orders.daily', key: 'org-1/orders.daily/default' });
  });
});
