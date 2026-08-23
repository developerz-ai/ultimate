import { describe, expect, test } from 'bun:test';
import {
  declaredErrorRetry,
  describeErrorCode,
  ERROR_DOCS_URL,
  isRetryableStatus,
  listErrorCodes,
  RETRYABLE_STATUSES,
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

// The HTTP leg's per-status override, asserted on the RENDERED error rather than on the instance:
// `toJSON()` is what `--json`, a job row's `lastError` and the queue's dead-letter record carry, and
// an assertion on the instance passes while the wire shape says something else.
describe('unit · the HTTP leg reads core`s ONE retryability table', () => {
  const policy = { attempts: 5, backoff: 'exponential' } as const;

  const renderedRetry = (status: number): unknown => {
    const json: unknown = JSON.parse(
      JSON.stringify(httpFailed('https://api.test/x', status, 'no')),
    );
    return (json as { readonly retry: unknown }).retry;
  };

  // Derived from core's set, never hand-listed: a status core adds later must not need an edit here
  // to be honoured on this leg — that divergence is the defect this test exists for.
  test('every status core calls retryable is retryable here too', () => {
    for (const status of RETRYABLE_STATUSES) {
      expect(renderedRetry(status), String(status)).toBe('retryable');
      expect(isRetryableStatus(status), String(status)).toBe(true);
    }
  });

  test('408, 409 and 425 keep their attempts — a transient 4xx is not a dead letter', () => {
    // The three this leg answered `terminal` on while `@ultimat3/cache`, `@ultimat3/mail` and
    // `@ultimat3/ai` all answered `retryable` for the same status, as of the same commit.
    for (const status of [408, 409, 425, 429]) {
      expect(renderedRetry(status), String(status)).toBe('retryable');
      const decision = nextRetryForError(policy, 1, httpFailed('https://api.test/x', status, 'no'));
      expect(decision.retry, String(status)).toBe(true);
      expect(decision.stoppedBy, String(status)).toBeUndefined();
    }
  });

  test('a 4xx that is the request`s own fault is still terminal on the attempt that threw it', () => {
    for (const status of [400, 401, 403, 404, 410, 422, 451]) {
      expect(renderedRetry(status), String(status)).toBe('terminal');
      const decision = nextRetryForError(policy, 1, httpFailed('https://api.test/x', status, 'no'));
      expect(decision.retry, String(status)).toBe(false);
      expect(decision.stoppedBy, String(status)).toBe('terminal');
    }
  });

  test('5xx is retryable whole, and a non-2xx below 400 keeps the code`s registered answer', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(renderedRetry(status), String(status)).toBe('retryable');
    }
    // A 304 is the reachable sub-400 non-ok (`responseOver`'s `ok` is 200-299, and `fetch` follows
    // redirects), and no table in the framework classifies it. Left as this code's registered
    // `retryable` — the override exists to name a PERMANENT 4xx, and an early dead-letter on a
    // status nobody has characterised is the expensive direction of that guess.
    expect(renderedRetry(304)).toBe('retryable');
  });
});
