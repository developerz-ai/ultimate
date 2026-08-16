// The read half of the propagation gap: a service-to-service read started a fresh root trace on
// the far side, so a cross-service read was unjoinable. The mirror of `@ultimat3/action`'s.

import { describe, expect, test } from 'bun:test';
import { parseTraceparent, withSpan } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { FetchLike } from './client';
import { queryClient } from './client';
import { query } from './query';
import { from } from './source';

interface Order {
  readonly id: string;
}

const listOrders = query({
  input: t.object({ orgId: t.string }),
  policy: can('order:read'),
  sql: () => from<Order>('orders', []),
}).named('listOrders');

const queries = { listOrders };

function capturing(): { readonly fetch: FetchLike; sent(): Headers } {
  let headers = new Headers();
  return {
    fetch: (_url, init) => {
      headers = new Headers(init.headers);
      return Promise.resolve(Response.json([]));
    },
    sent: () => headers,
  };
}

describe('the typed read client propagates the trace', () => {
  test('a read inside a span sends a traceparent on the caller trace', async () => {
    const capture = capturing();
    const client = queryClient<typeof queries>({ baseUrl: 'https://b.test', fetch: capture.fetch });
    const traceId = await withSpan('a.reads.b', async (span) => {
      await client.listOrders({ orgId: 'o1' });
      return span.context.traceId;
    });
    expect(parseTraceparent(capture.sent().get('traceparent'))?.traceId).toBe(traceId);
  });

  test('no ambient trace sends no header, so a browser read gains no CORS preflight', async () => {
    const capture = capturing();
    const client = queryClient<typeof queries>({ baseUrl: 'https://b.test', fetch: capture.fetch });
    await client.listOrders({ orgId: 'o1' });
    expect(capture.sent().get('traceparent')).toBeNull();
  });

  test('an explicit header still wins', async () => {
    const capture = capturing();
    const forced = '00-11111111111111111111111111111111-2222222222222222-01';
    const client = queryClient<typeof queries>({
      baseUrl: 'https://b.test',
      fetch: capture.fetch,
      headers: { traceparent: forced },
    });
    await withSpan('a.reads.b', () => client.listOrders({ orgId: 'o1' }));
    expect(capture.sent().get('traceparent')).toBe(forced);
  });
});
