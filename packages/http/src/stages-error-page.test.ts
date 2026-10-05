// Which page a BROWSER gets from a DEV process (#492, O-492 (a)): a 4xx is the app's own page when
// it has one — the author is looking at what a visitor will see — and a 5xx is the overlay, because
// a defect is what dev exists to debug. Production is pinned beside it so the two cannot drift.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { createRouter, type Route } from './router';

const SECRET = 'connect ECONNREFUSED 10.0.0.7:5432';
const OWN_404 = '<!doctype html><title>ours</title>Lost at sea';
const OWN_500 = '<!doctype html><title>ours</title>We broke it';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/boom',
    meta: { name: 'boom', auth: 'public' },
    handler: () => {
      throw new TypeError(SECRET);
    },
  },
];

const pipelineWith = (dev: boolean, errorPage: (status: number) => string | undefined) =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev, buildId: null }),
    hooks: { errorPage },
  });

const appPages = (asked: number[]) => (status: number) => {
  asked.push(status);
  return status === 404 ? OWN_404 : status === 500 ? OWN_500 : undefined;
};

const browser = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { accept: 'text/html' } });

describe('a browser, in dev', () => {
  test("a 404 serves the app's own page, byte for byte", async () => {
    const asked: number[] = [];
    const response = await pipelineWith(true, appPages(asked)).handle(browser('/nope'), {
      role: 'web',
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(OWN_404);
    expect(asked).toEqual([404]);
  });

  test('a 4xx the app has no page for keeps the overlay — the diagnostic, not a blank', async () => {
    const response = await pipelineWith(true, () => undefined).handle(browser('/nope'), {
      role: 'web',
    });
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain('X_ROUTE_NOT_FOUND');
    expect(body).toContain('x routes --json');
  });

  test('a 500 is the overlay, and the hook is never asked', async () => {
    const asked: number[] = [];
    const response = await pipelineWith(true, appPages(asked)).handle(browser('/boom'), {
      role: 'web',
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain(SECRET);
    expect(body).not.toContain('We broke it');
    expect(asked).toEqual([]);
  });
});

describe('a browser, in production — unchanged', () => {
  test("a 404 serves the app's own page", async () => {
    const response = await pipelineWith(false, appPages([])).handle(browser('/nope'), {
      role: 'web',
    });
    expect(await response.text()).toBe(OWN_404);
  });

  test("a 500 serves the app's own page and never the cause", async () => {
    const response = await pipelineWith(false, appPages([])).handle(browser('/boom'), {
      role: 'web',
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe(OWN_500);
    expect(body).not.toContain(SECRET);
  });
});
