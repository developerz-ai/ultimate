/**
 * contract — `X_POST_NOT_FOUND` over HTTP. Until 2026-11 the code was a handwritten subclass with
 * no status row, so a miss answered 500: the cause was blanked for the caller, and the error
 * monitor heard about every typo'd post id. `defineError` declares the 404 in the same call.
 */

import { toRoute } from '@ultimat3/action';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { expect, test } from '@ultimat3/testing';
import { createComment } from './actions/create-comment';

test('a post id the actor’s org does not hold answers 404 and says which post', async ({
  seed,
  actorFor,
}) => {
  // Kenji reads Acme; `post:offline` is Tinta's. `postRead` passes on input, and `byId` — scoped to
  // the actor's org — finds nothing: the miss, not a denial (`actions.contract.test.ts` pins that).
  const { foreign, acme, reader } = await seed('dev').pick({
    foreign: 'post:offline',
    acme: 'org:acme',
    reader: 'member:kenji',
  });
  const route = toRoute(createComment);
  const server = httpServer({
    routes: [route],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(reader) },
  });
  const response = await server.fetch(
    new Request(`http://dev.test${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
      body: JSON.stringify({
        postId: foreign.id,
        orgId: acme.id,
        body: 'across a tenant boundary',
      }),
    }),
  );
  const problem = (await response.json()) as { readonly code?: string; readonly cause?: string };
  expect(problem.code).toBe('X_POST_NOT_FOUND');
  expect(response.status).toBe(404);
  expect(problem.cause).toContain(foreign.id);
});
