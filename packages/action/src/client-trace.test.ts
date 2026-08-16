// A service-to-service call has to continue the caller's trace. `traceparent()` existed in
// `@ultimat3/core` and nothing in the repo called it, so every Ultimate-to-Ultimate hop started a
// fresh root on the far side and "which of my 40 downstreams is slow" had no answer at all.

import { describe, expect, test } from 'bun:test';
import { parseTraceparent, withSpan } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { type FetchLike, rpc } from './client';

const publishPost = action({
  input: t.object({ postId: t.uuid }),
  output: t.object({ ok: t.boolean }),
  policy: can('post:publish'),
  handle: () => ({ ok: true }),
}).named('publishPost');

const actions = { publishPost };
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

/** Captures the headers one call sent. */
function capturing(): { readonly fetch: FetchLike; sent(): Headers } {
  let headers = new Headers();
  return {
    fetch: (_url, init) => {
      headers = new Headers(init.headers);
      return Promise.resolve(Response.json({ ok: true }));
    },
    sent: () => headers,
  };
}

describe('the typed client propagates the trace', () => {
  test('a call inside a span sends a traceparent on the caller trace', async () => {
    const capture = capturing();
    const api = rpc<typeof actions>({ baseUrl: 'https://b.test', fetch: capture.fetch });
    const traceId = await withSpan('a.calls.b', async (span) => {
      await api.publishPost({ postId: POST_ID });
      return span.context.traceId;
    });
    const sent = parseTraceparent(capture.sent().get('traceparent'));
    expect(sent).toBeDefined();
    // The same trace, not a fresh root — that is the entire finding.
    expect(sent?.traceId).toBe(traceId);
  });

  test('no ambient trace sends no header, so a browser call is unchanged', async () => {
    const capture = capturing();
    const api = rpc<typeof actions>({ baseUrl: 'https://b.test', fetch: capture.fetch });
    await api.publishPost({ postId: POST_ID });
    expect(capture.sent().get('traceparent')).toBeNull();
  });

  test('an explicit header still wins — the caller is never overridden', async () => {
    const capture = capturing();
    const forced = '00-11111111111111111111111111111111-2222222222222222-01';
    const api = rpc<typeof actions>({
      baseUrl: 'https://b.test',
      fetch: capture.fetch,
      headers: { traceparent: forced },
    });
    await withSpan('a.calls.b', () => api.publishPost({ postId: POST_ID }));
    expect(capture.sent().get('traceparent')).toBe(forced);
  });
});
