// `action.client()` for a parameterised pin: the URL filled from the input, each value encoded as
// one segment, the key left out of the body, the declared method sent; a missing value refused.

import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';

interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

const recording = (): { sent: Sent[]; fetch: FetchLike } => {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (input, init) => {
      const raw = init?.body;
      sent.push({
        url: String(input),
        method: init?.method,
        body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
};

const refund = action({
  input: t.object({ id: t.string, reason: t.string }),
  output: t.object({ ok: t.boolean }),
  policy: allow('order:refund'),
  http: { path: '/orders/:id/refund', method: 'PATCH' },
  handle: () => ({ ok: true }),
}).named('refundOrder');

describe('action.client() on a :param pin', () => {
  test('substitutes and encodes, sends the method, and leaves the key out of the body', async () => {
    const seen = recording();
    await refund.client({ baseUrl: 'http://app.test/', fetch: seen.fetch })({
      id: 'a/b c',
      reason: 'dup',
    });
    expect(seen.sent).toEqual([
      { url: 'http://app.test/orders/a%2Fb%20c/refund', method: 'PATCH', body: { reason: 'dup' } },
    ]);
  });

  test('a missing value is refused before anything is sent', async () => {
    const seen = recording();
    const call = refund.client({ baseUrl: 'http://app.test', fetch: seen.fetch });
    try {
      await call({ id: '', reason: 'dup' });
      expect.unreachable('an empty :id must be refused');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: 'X_ACTION_HTTP_PATH_INVALID' }));
    }
    expect(seen.sent).toEqual([]);
  });

  test('a static pin is unchanged: POST, the whole input as the body', async () => {
    const seen = recording();
    const hook = action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow('hook:receive'),
      http: { path: '/api/hooks/in' },
      handle: () => ({ ok: true }),
    }).named('hookIn');
    await hook.client({ baseUrl: 'http://app.test', fetch: seen.fetch })({ id: 'x' });
    expect(seen.sent).toEqual([
      { url: 'http://app.test/api/hooks/in', method: 'POST', body: { id: 'x' } },
    ]);
  });
});
