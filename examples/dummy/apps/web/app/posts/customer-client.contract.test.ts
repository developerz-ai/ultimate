/**
 * contract — the customer client (`x client customer --out apps/web/clients/postly --only
 * posts,query`) against the app's real query route: no framework import on the caller's side, and
 * the rows come back typed by the document `x manifest` publishes. A renamed query or column fails
 * here as `contract-diff` would, from the customer's chair.
 */

import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { expect, test } from '@ultimat3/testing';
import { createClient, ProblemError } from '../../clients/postly';
import { orgPosts } from './queries/org-posts';

test('a customer reads an org’s posts through the generated client', async ({ seed, actorFor }) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const server = httpServer({
    routes: [toQueryRoute(orgPosts)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  const client = createClient({
    baseUrl: 'http://dev.test',
    fetch: (url, init) => server.fetch(new Request(url, init)),
  });
  const page = await client.orgPosts({ orgId: ada.orgId });
  const rows = Array.isArray(page.data) ? page.data : page.data.rows;
  expect(rows.length).toBeGreaterThan(0);
  // Typed by the document: `status` is the published enum, `orgId` the tenant asked for.
  for (const row of rows) {
    expect(row.orgId).toBe(ada.orgId);
    expect(['draft', 'scheduled', 'published']).toContain(row.status);
  }
});

test('a refusal is a ProblemError carrying the status and the code', async ({ seed, actorFor }) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const server = httpServer({
    routes: [toQueryRoute(orgPosts)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  const client = createClient({
    baseUrl: 'http://dev.test',
    fetch: (url, init) => server.fetch(new Request(url, init)),
  });
  const error = await client.orgPosts({ orgId: 'not-a-uuid' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProblemError);
  expect((error as ProblemError).status).toBe(400);
  expect((error as ProblemError).code).toBe('X_INPUT_INVALID');
});
