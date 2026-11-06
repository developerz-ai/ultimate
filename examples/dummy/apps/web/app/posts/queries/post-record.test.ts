// `postRecord` answers with a validator: the like island re-reads it on every load of
// `/posts/{id}` and once a minute after, and an unchanged post costs a bodiless 304, not its row.
// The validator is the member's own: one reader's copy never confirms another's.

import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { expect, test } from '@ultimat3/testing';
import { postRecord } from './post-record';

test('an unchanged post answers 304, and another member’s copy is not confirmed by it', async ({
  seed,
  actorFor,
}) => {
  const { ada, post } = await seed('dev').pick({ ada: 'member:ada', post: 'post:tenancy' });
  const server = httpServer({
    routes: [toQueryRoute(postRecord)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  const url = `http://dev.test/_x/query/post-record?orgId=${ada.orgId}&postId=${post.id}`;
  const read = (etag?: string) =>
    server.fetch(
      new Request(url, etag === undefined ? {} : { headers: { 'if-none-match': etag } }),
    );

  const first = await read();
  expect(first.status).toBe(200);
  // Stored by the browser, never shared, and asked again before every reuse.
  expect(first.headers.get('cache-control')).toBe('private, no-cache');
  const etag = first.headers.get('etag') ?? '';
  expect(etag).toMatch(/^"[\w-]+"$/);
  await first.arrayBuffer();

  const again = await read(etag);
  expect(again.status).toBe(304);
  expect(await again.text()).toBe('');
  expect(again.headers.get('etag')).toBe(etag);

  // Kenji, in the same org, reads the same post and still gets the body: his own validator.
  const { kenji } = await seed('dev').pick({ kenji: 'member:kenji' });
  const other = httpServer({
    routes: [toQueryRoute(postRecord)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(kenji) },
  });
  const foreign = await other.fetch(new Request(url, { headers: { 'if-none-match': etag } }));
  expect(foreign.status).toBe(200);
});
