// `@ultimat3/query/client` is the typed read client WITHOUT the barrel: the barrel anchors the query
// registry and the server projections a browser never runs. Pinned by resolving the SPECIFIER — a
// subpath the exports map does not carry is a build error in every island that names it.

import { expect, test } from 'bun:test';

test('the client subpath resolves and carries the read client and nothing server-side', async () => {
  const client: Record<string, unknown> = await import('@ultimat3/query/client');

  expect(client['queryClient']).toBeTypeOf('function');
  expect(client['queryClientMethodFor']).toBeTypeOf('function');
  expect(client['toQueryRoute']).toBeUndefined();
  expect(client['query']).toBeUndefined();
});
