import { describe, expect, test } from 'bun:test';
import { FRAMEWORK_CATALOG, placeholdersOf } from '@ultimat3/i18n';
import { ERROR_STATUS } from './error-map';
import {
  ERROR_PAGE_LINKS,
  errorPageResponse,
  renderErrorPage,
  resolveErrorPageCopy,
} from './error-page';

const input = (over: Partial<Parameters<typeof renderErrorPage>[0]> = {}) => ({
  status: 404,
  code: 'X_ROUTE_NOT_FOUND',
  path: '/nope',
  requestId: 'req-1',
  locale: 'en',
  ...over,
});

describe('which copy a status gets', () => {
  test('the statuses with their own words get them', () => {
    expect(resolveErrorPageCopy(input({ status: 404 })).group).toBe('notFound');
    expect(resolveErrorPageCopy(input({ status: 401, code: 'X_UNAUTHENTICATED' })).group).toBe(
      'unauthorized',
    );
    expect(resolveErrorPageCopy(input({ status: 503, code: 'X_DRAINING' })).group).toBe(
      'unavailable',
    );
  });

  test('a status whose copy needs a value nothing supplied falls to its class', () => {
    // `errors.forbidden.body` names {permission}; without a route policy there is no such value,
    // and rendering ⟦permission⟧ at a visitor is worse than the plainer sentence.
    expect(resolveErrorPageCopy(input({ status: 403, code: 'X_FORBIDDEN' })).group).toBe(
      'badRequest',
    );
    expect(
      resolveErrorPageCopy(input({ status: 403, code: 'X_FORBIDDEN', permission: 'post:publish' }))
        .group,
    ).toBe('forbidden');
    expect(resolveErrorPageCopy(input({ status: 429, code: 'X_RATE_LIMITED' })).group).toBe(
      'badRequest',
    );
    expect(
      resolveErrorPageCopy(input({ status: 429, code: 'X_RATE_LIMITED', retryAfterSeconds: 30 }))
        .group,
    ).toBe('rateLimited');
  });

  test('EVERY status the framework can answer with has copy, and every placeholder is supplied', () => {
    for (const status of new Set(Object.values(ERROR_STATUS))) {
      const copy = resolveErrorPageCopy(input({ status, code: 'X_INTERNAL' }));
      for (const part of ['title', 'body', 'action'] as const) {
        const key = `errors.${copy.group}.${part}`;
        const template = FRAMEWORK_CATALOG[key];
        expect(template === undefined ? key : template).not.toBe(key);
        for (const name of placeholdersOf(template ?? '')) {
          expect(Object.hasOwn(copy.vars, name) ? name : `${key} wants {${name}}`).toBe(name);
        }
      }
    }
  });
});

describe('the page itself', () => {
  test('says the status, the code and the words — and links back to Ultimate', () => {
    const page = renderErrorPage(input());
    expect(page).toStartWith('<!doctype html>');
    expect(page).toContain('Page not found');
    expect(page).toContain('X_ROUTE_NOT_FOUND');
    expect(page).toContain('>404<');
    expect(page).toContain(`href="${ERROR_PAGE_LINKS.repository}"`);
    expect(page).toContain(`href="${ERROR_PAGE_LINKS.homepage}"`);
    expect(ERROR_PAGE_LINKS.repository).toBe('https://github.com/developerz-ai/ultimate');
    expect(ERROR_PAGE_LINKS.homepage).toBe('https://www.developerz.ai');
  });

  test('renders no key literal — every string it shows is in the catalog', () => {
    for (const status of new Set(Object.values(ERROR_STATUS))) {
      expect(renderErrorPage(input({ status }))).not.toContain('⟦');
    }
  });

  test('the visitor is never shown the cause, the fix or the stack', () => {
    const page = renderErrorPage(
      input({ status: 500, code: 'X_INTERNAL', requestId: 'req-secret-carrier' }),
    );
    expect(page).not.toContain('undefined is not a function');
    expect(page).not.toContain('x errors explain');
    // The request id IS shown: it is what a visitor quotes to support, and it names nothing.
    expect(page).toContain('req-secret-carrier');
  });

  test('a value an app names in its own copy is escaped, never injected', () => {
    // `errors.forbidden.body` is the one shipped sentence carrying a value off the request.
    const page = renderErrorPage(
      input({ status: 403, code: 'X_FORBIDDEN', permission: '<script>alert(1)</script>' }),
    );
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;');
  });

  test('a page with no request behind it renders whole — no request row, no bracketed key', () => {
    // What `x build --target static` writes as `404.html`: no request id, no pathname.
    const page = renderErrorPage({ status: 404, code: 'X_ROUTE_NOT_FOUND', locale: 'en' });
    expect(page).toContain('Page not found');
    expect(page).not.toContain('⟦');
    expect(page).not.toContain('<dt>request</dt>');
  });

  test('the response is html, carries the status and is never cached', async () => {
    const response = errorPageResponse(input({ status: 503, code: 'X_DRAINING' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('<!doctype html>');
  });

  test("an app's own page wins verbatim", async () => {
    const own = '<!doctype html><title>ours</title><h1>Gone fishing</h1>';
    const response = errorPageResponse(input(), { override: own });
    expect(await response.text()).toBe(own);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});
