import { describe, expect, test } from 'bun:test';
import {
  declaredErrorRetry,
  describeErrorCode,
  ERROR_DOCS_URL,
  listErrorCodes,
  retryFor,
} from '@ultimat3/core';
import { nextRetryForError } from '@ultimat3/jobs';
import { authFailed, httpFailed, pageCrashed, watchdogStopped, wedged } from './error-throws';
import {
  isRetryableScrapeError,
  SCRAPE_ERROR_RETRY,
  SCRAPE_ERROR_TITLES,
  SCRAPE_OWNED_ERROR_CODES,
  ScrapeError,
} from './errors';

describe('unit · @ultimat3/scraping error codes', () => {
  test('every declared code is namespaced and screaming snake case', () => {
    for (const code of SCRAPE_OWNED_ERROR_CODES) expect(code).toMatch(/^X_SCRAPE_[A-Z0-9_]+$/);
  });

  test('every owned code has a title and a RETRY CLASSIFICATION', () => {
    // The classification is the point of this package's taxonomy: "was that the site being slow or
    // the site being different?" is the only operational question a scraper has, and a code with
    // no answer to it falls back to `terminal` silently.
    for (const code of SCRAPE_OWNED_ERROR_CODES) {
      expect(SCRAPE_ERROR_TITLES[code], code).toBeString();
      expect(SCRAPE_ERROR_RETRY[code], code).toMatch(/^(?:retryable|terminal)$/);
    }
  });

  test('importing this package registers its codes in the process registry', () => {
    const registered = new Set(listErrorCodes().map((entry) => entry.code));
    for (const code of SCRAPE_OWNED_ERROR_CODES) expect(registered.has(code), code).toBe(true);
  });

  test('the registry agrees with the table — a rejected credential is TERMINAL', () => {
    expect(retryFor('X_SCRAPE_AUTH_FAILED')).toBe('terminal');
    expect(retryFor('X_SCRAPE_PAGE_CRASHED')).toBe('terminal');
    expect(retryFor('X_SCRAPE_WEDGED')).toBe('retryable');
  });

  test('an error carries a stable code, a cause, a fix and a per-instance retry override', () => {
    const error = new ScrapeError({
      code: 'X_SCRAPE_HTTP_FAILED',
      cause: 'because',
      fix: 'x doctor --json',
      retry: 'terminal',
    });
    expect(error.code).toBe('X_SCRAPE_HTTP_FAILED');
    expect(error.fix).toBe('x doctor --json');
    expect(error.retry).toBe('terminal');
    expect(isRetryableScrapeError(error)).toBe(false);
  });
});

describe('unit · the classification is load-bearing, not documentation', () => {
  // `executeJob` reads the thrown code's classification (`nextRetryForError`), and
  // `classifyThrown` honours `terminal` only for a code that was REGISTERED — a package that
  // classified a code in a table and never called `registerErrorRetry` would silently retry it.
  // These assertions are against the queue's own decision function, not against our table.
  const policy = { attempts: 5, backoff: 'exponential' } as const;

  test('a rejected credential dead-letters at attempt 1 — no second wrong password', () => {
    const decision = nextRetryForError(policy, 1, authFailed('orders', 'wrong password'));
    expect(decision.retry).toBe(false);
    expect(decision.stoppedBy).toBe('terminal');
  });

  test('a crashed renderer is terminal too — a half-submitted form is never replayed', () => {
    expect(nextRetryForError(policy, 1, pageCrashed('https://shop.test/')).retry).toBe(false);
  });

  test('a wedged browser keeps its attempts — the retry table is not "everything is terminal"', () => {
    const decision = nextRetryForError(policy, 1, wedged('scrape "orders"', 120_000));
    expect(decision.retry).toBe(true);
    expect(decision.stoppedBy).toBeUndefined();
  });

  test('a guard that STOPPED MEASURING is terminal — the sibling code is the whole point', () => {
    // The two ways the watchdog ends a run, side by side. A wedge is the site or the browser being
    // slow, so attempt 2 may go differently; this one is the guard's own loop dying on a clock the
    // DEFINITION supplied, which attempt 2 reaches identically — five browser launches and five
    // arrivals at a login for no chance of a different answer. The `new Error` is the guard's
    // input, not a verdict.
    const decision = nextRetryForError(
      policy,
      1,
      watchdogStopped('scrape "orders"', new Error('the clock stopped')),
    );
    expect(decision.retry).toBe(false);
    expect(decision.stoppedBy).toBe('terminal');
  });

  test('a per-instance override is honoured because the CODE is registered', () => {
    // `X_SCRAPE_HTTP_FAILED` is registered `retryable`; a 404 is thrown with `retry: 'terminal'`.
    expect(nextRetryForError(policy, 1, httpFailed('https://api.test/x', 404, 'no')).retry).toBe(
      false,
    );
    expect(nextRetryForError(policy, 1, httpFailed('https://api.test/x', 429, 'slow')).retry).toBe(
      true,
    );
  });

  test('every code this package classifies is registered — a table entry is not enough', () => {
    for (const code of SCRAPE_OWNED_ERROR_CODES) {
      expect(declaredErrorRetry(code), code).toBe(SCRAPE_ERROR_RETRY[code]);
    }
  });
});

// `ScrapeError` passes no `docs:`, so the link is whatever the registry resolved: one page for
// every code, declared once in `@ultimat3/core`. Pinned against the constant and never a literal —
// a hand-copied URL is how the dead `https://ultimate.dev/errors/<code>` host survived every suite
// in the tree, with the code interpolated into a fragment no page has ever had an anchor for.
describe('unit · docs', () => {
  test('a constructed scrape error points at the one page, never a per-code URL', () => {
    const errors = [
      authFailed('shop.test', 'no cookie'),
      httpFailed('https://api.test/x', 429, 'slow'),
      pageCrashed('https://shop.test'),
      wedged('https://shop.test', 30_000),
    ];
    for (const error of errors) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      expect(error.docs).not.toContain(error.code);
    }
  });

  test('and every owned code resolves to that same link through the registry', () => {
    for (const code of SCRAPE_OWNED_ERROR_CODES) {
      expect(describeErrorCode(code).docs, code).toBe(ERROR_DOCS_URL);
      expect(describeErrorCode(code).title, code).toBe(SCRAPE_ERROR_TITLES[code]);
    }
  });
});
