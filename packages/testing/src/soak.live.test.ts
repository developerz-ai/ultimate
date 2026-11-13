// The framework's heap canary: 20,000 requests through the real HTTP pipeline — a server-rendered
// page, an action, a query, and the 404 and 400 refusals — and the live heap after a full GC
// held under a measured bound. Here rather than in a unit file: it is the one suite that is slow
// on purpose, and the `live` step is where the gate runs the slow suites.

import { describe, expect, test } from 'bun:test';
import { action, toRoute } from '@ultimat3/action';
import { userActor } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { from, query, toQueryRoute } from '@ultimat3/query';
import { h } from '@ultimat3/render';
import { renderToHtml } from '@ultimat3/render/server';
import { t } from '@ultimat3/schema';
import { soak } from './soak';

/**
 * Measured 2026-11-13 on Bun 1.4.4 (linux x64), three runs of 20,000 requests after a 2,000
 * warm-up: GROWTH_RUNS bytes, about 13 bytes a request — and not a leak: 5k, 40k and 80k requests
 * grew 202 KB, 332 KB and -454 KB, so it is collector noise, not a slope. The bound is the
 * largest × 1.5 (plan 15 T2): 404 KB. A planted leak of one four-field object per PAGE request
 * (4,000 of the 20,000) grew 726 KB and was refused.
 */
const GROWTH_RUNS = [269_194, 266_518, 265_050] as const;
const MAX_GROWTH_BYTES = Math.ceil(Math.max(...GROWTH_RUNS) * 1.5);

const ORIGIN = 'http://soak.test';

const createNote = action({
  input: t.object({ title: t.string.min(1) }),
  output: t.object({ id: t.string, title: t.string }),
  policy: allow('note:create'),
  http: { method: 'POST', path: '/api/notes' },
  handle: ({ input }) => ({ id: `n-${input.title.length}`, title: input.title }),
}).named('soakCreateNote');

interface Note {
  readonly id: string;
  readonly n: number;
}

const listNotes = query({
  input: t.object({ n: t.number }),
  policy: can('note:read'),
  sql: ({ n }) =>
    from<Note>('notes', [
      { id: 'a', n },
      { id: 'b', n: n + 1 },
    ]),
}).named('soakListNotes');

const page: Route = {
  method: 'GET',
  path: '/page/:id',
  meta: { name: 'soakPage', auth: 'public' },
  handler: async (request) => {
    const id = new URL(request.url).pathname.slice('/page/'.length);
    const html = await renderToHtml(
      h(
        'main',
        { id: `p-${id}` },
        h('ol', null, ...[1, 2, 3].map((n) => h('li', { key: n }, String(n)))),
      ),
    );
    return new Response(`<!doctype html>${html}`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};

const reader = { ...userActor({ id: 'u1' }), permissions: ['note:read'] };

const queryRoute = toQueryRoute(listNotes);

const server = httpServer({
  routes: [page, toRoute(createNote), queryRoute],
  config: defineHttpConfig({
    rateLimit: {
      scope: 'process',
      buckets: { default: { capacity: 1_000_000_000, refillPerSecond: 1_000_000_000 } },
    },
  }),
  hooks: { authenticate: () => reader },
});

/** A new id per request, so no path is ever served the same URL twice. */
let counter = 0;
const next = (): number => {
  counter += 1;
  return counter;
};
const json = (path: string, body: unknown): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });

const requests: [() => Request, ...(() => Request)[]] = [
  () => new Request(`${ORIGIN}/page/${next()}`),
  () => json('/api/notes', { title: `t${next()}` }),
  () => new Request(`${ORIGIN}${queryRoute.path}?n=${next()}`),
  () => new Request(`${ORIGIN}/missing/${next()}`),
  () => json('/api/notes', { title: '' }),
];

describe('heap canary', () => {
  test('20,000 requests across SSR, action, query and 4xx leave the heap flat', async () => {
    const report = await soak({
      fetch: (request) => server.fetch(request),
      requests,
      maxGrowthBytes: MAX_GROWTH_BYTES,
    });
    // Every path answered as itself: a soak that only ever 500s soaked nothing.
    expect([...report.statuses.keys()].sort()).toEqual([200, 400, 404]);
    expect(report.statuses.get(200)).toBe(12_000);
  }, 120_000);
});
