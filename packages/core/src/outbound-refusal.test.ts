// How `outbound()` reads a refusal's body: by default a redacted 200-character excerpt of the
// chunks that decode its first 1,024 characters, `meta.detail`; with `refusal: { schema }` the whole body, its declared fields at
// `meta.fields`; with `refusal: { detail: false }` no excerpt at all.

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { isUltimateError, type UltimateError } from './errors';
import { redactValues } from './logger-redact';
import { outbound } from './outbound';
import { manualTimer, recordedSleep, recordingFetch } from './outbound-fixture';
import type { OutboundRequest } from './outbound-types';

type BytesCall = OutboundRequest & { readonly read?: 'bytes' | undefined };
const call = (over: Partial<BytesCall> = {}): BytesCall => ({
  url: 'https://api.vendor.test/v1/charges',
  vendor: 'vendor',
  dial: 'named',
  method: 'POST',
  deadlineMs: 60_000,
  ...over,
});

async function caught(work: Promise<unknown>): Promise<UltimateError> {
  try {
    await work;
  } catch (error) {
    if (isUltimateError(error)) return error;
    throw error;
  }
  return expect.unreachable('the call answered');
}

/** The body in 256-byte chunks, as a network delivers a large one. */
const chunked = (body: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(body);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + 256));
      at += 256;
    },
  });
};

/** The same chunks, counting what was pulled and whether the reader cancelled. */
const tracked = (body: string) => {
  const bytes = new TextEncoder().encode(body);
  const state = { pulled: 0, cancelled: false, total: bytes.length };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(state.pulled, state.pulled + 256));
        state.pulled += 256;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
};

const refusing = (status: number, body: string) =>
  recordingFetch(() => new Response(chunked(body), { status })).fetch;

/** A decline whose code sits past the first KiB, behind a large nested object. */
const LARGE_DECLINE = JSON.stringify({
  error: { payment_intent: { d: 'x'.repeat(2000) }, decline_code: 'insufficient_funds' },
});

const declineSchema = t.object({ error: t.object({ decline_code: t.string }) });

describe('unit · outbound · refusal body', () => {
  test('default: a JSON body past the first KiB leaves meta.detail empty, and no fields', async () => {
    const error = await caught(
      outbound(call(), { fetch: refusing(402, LARGE_DECLINE), timer: manualTimer() }),
    );
    expect(error.code).toBe('X_OUTBOUND_REFUSED');
    expect(error.meta?.['detail']).toBe('');
    expect(error.meta !== undefined && 'fields' in error.meta).toBe(false);
  });

  test('a schema reads the whole body: its declared fields are meta.fields', async () => {
    const error = await caught(
      outbound(call({ refusal: { schema: declineSchema } }), {
        fetch: refusing(402, LARGE_DECLINE),
        timer: manualTimer(),
      }),
    );
    expect(error.code).toBe('X_OUTBOUND_REFUSED');
    expect(error.meta?.['fields']).toEqual({ error: { decline_code: 'insufficient_funds' } });
    // Undeclared keys never reach meta.fields: the schema is the whole of what it keeps.
    expect(JSON.stringify(error.meta?.['fields'])).not.toContain('xxxx');
    // meta.detail is the excerpt of the WHOLE body, not of its first KiB (which does not parse).
    expect(error.meta?.['detail']).toBe(LARGE_DECLINE.slice(0, 200));
  });

  test('a declared field with a credential name is still redacted', async () => {
    const schema = t.object({ code: t.string, client_secret: t.string });
    const body = JSON.stringify({ code: 'card_declined', client_secret: 'pi_SECRET' });
    const error = await caught(
      outbound(call({ refusal: { schema } }), { fetch: refusing(402, body), timer: manualTimer() }),
    );
    expect(error.meta?.['fields']).toEqual({ code: 'card_declined', client_secret: '[redacted]' });
    expect(JSON.stringify(error.meta)).not.toContain('pi_SECRET');
  });

  test('a body that is not JSON, or does not fit the schema, carries no fields', async () => {
    for (const body of ['<html>oops</html>', JSON.stringify({ error: { other: 1 } })]) {
      const error = await caught(
        outbound(call({ refusal: { schema: declineSchema } }), {
          fetch: refusing(400, body),
          timer: manualTimer(),
        }),
      );
      expect(error.code).toBe('X_OUTBOUND_REFUSED');
      expect(error.meta !== undefined && 'fields' in error.meta).toBe(false);
    }
  });

  test('a body past the call maxBytes carries no fields: the read stops at the cap', async () => {
    const { stream, state } = tracked(LARGE_DECLINE);
    const error = await caught(
      outbound(call({ maxBytes: 512, refusal: { schema: declineSchema } }), {
        fetch: recordingFetch(() => new Response(stream, { status: 402 })).fetch,
        timer: manualTimer(),
      }),
    );
    expect(error.code).toBe('X_OUTBOUND_REFUSED');
    expect(error.meta !== undefined && 'fields' in error.meta).toBe(false);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(state.total);
  });

  test('default: a short body keeps free text in meta.detail', async () => {
    const body = JSON.stringify({ error: { message: 'a@b.com' } });
    const error = await caught(
      outbound(call(), { fetch: refusing(400, body), timer: manualTimer() }),
    );
    expect(error.meta?.['detail']).toBe(body);
  });

  test('detail: false drops the excerpt; the schema still answers', async () => {
    const body = JSON.stringify({ error: { message: 'a@b.com', decline_code: 'expired_card' } });
    const plain = await caught(
      outbound(call({ refusal: { detail: false } }), {
        fetch: refusing(400, body),
        timer: manualTimer(),
      }),
    );
    expect(plain.meta?.['detail']).toBe('');
    const { stream, state } = tracked(LARGE_DECLINE);
    const unread = await caught(
      outbound(call({ refusal: { detail: false } }), {
        fetch: recordingFetch(() => new Response(stream, { status: 400 })).fetch,
        timer: manualTimer(),
      }),
    );
    expect(unread.meta?.['detail']).toBe('');
    // With no schema to answer, the body is cancelled, not drained.
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(state.total);
    const picked = await caught(
      outbound(call({ refusal: { detail: false, schema: declineSchema } }), {
        fetch: refusing(400, body),
        timer: manualTimer(),
      }),
    );
    expect(picked.meta?.['detail']).toBe('');
    expect(picked.meta?.['fields']).toEqual({ error: { decline_code: 'expired_card' } });
    expect(JSON.stringify(picked.meta)).not.toContain('a@b.com');
  });

  test('a retried 503 and a throttled 429 carry the fields too', async () => {
    const body = JSON.stringify({ error: { decline_code: 'try_later' } });
    // A different code per attempt: the error carries the LAST attempt's fields.
    const { fetch, calls } = recordingFetch(
      (_call, n) =>
        new Response(chunked(JSON.stringify({ error: { decline_code: `attempt_${String(n)}` } })), {
          status: 503,
        }),
    );
    const unavailable = await caught(
      outbound(call({ method: 'GET', refusal: { schema: declineSchema } }), {
        fetch,
        ...recordedSleep(),
        timer: manualTimer(),
      }),
    );
    expect(unavailable.code).toBe('X_OUTBOUND_UNAVAILABLE');
    expect(calls).toHaveLength(3);
    expect(unavailable.meta?.['fields']).toEqual({ error: { decline_code: 'attempt_3' } });
    const throttled = await caught(
      outbound(call({ refusal: { schema: declineSchema } }), {
        fetch: recordingFetch(
          () => new Response(body, { status: 429, headers: { 'retry-after': '3' } }),
        ).fetch,
        timer: manualTimer(),
      }),
    );
    expect(throttled.code).toBe('X_OUTBOUND_THROTTLED');
    expect(throttled.meta?.['fields']).toEqual({ error: { decline_code: 'try_later' } });
  });
});

describe('unit · outbound · refusal headers', () => {
  const answering = (status: number, headers: Record<string, string>) =>
    recordingFetch(() => new Response('{}', { status, headers })).fetch;

  test('refusal.headers puts the named headers of a 4xx, 5xx and 429 at meta.headers, lowercased', async () => {
    const headers = { 'X-Request-Id': 'req_123', 'cf-ray': 'ray-9', server: 'vendor' };
    const refused = await caught(
      outbound(call({ refusal: { headers: ['X-REQUEST-ID', 'CF-Ray', 'x-absent'] } }), {
        fetch: answering(402, headers),
        timer: manualTimer(),
      }),
    );
    expect(refused.code).toBe('X_OUTBOUND_REFUSED');
    // Only what was asked and present: `server` was not named, `x-absent` is not there.
    expect(refused.meta?.['headers']).toEqual({ 'x-request-id': 'req_123', 'cf-ray': 'ray-9' });

    const attempts = recordingFetch(
      (_call, n) => new Response('{}', { status: 503, headers: { 'x-request-id': `req_${n}` } }),
    );
    const unavailable = await caught(
      outbound(call({ method: 'GET', refusal: { headers: ['x-request-id'] } }), {
        fetch: attempts.fetch,
        ...recordedSleep(),
        timer: manualTimer(),
      }),
    );
    expect(unavailable.code).toBe('X_OUTBOUND_UNAVAILABLE');
    expect(attempts.calls).toHaveLength(3);
    expect(unavailable.meta?.['headers']).toEqual({ 'x-request-id': 'req_3' });

    const throttled = await caught(
      outbound(call({ refusal: { headers: ['x-request-id'] } }), {
        fetch: answering(429, { ...headers, 'retry-after': '3' }),
        timer: manualTimer(),
      }),
    );
    expect(throttled.code).toBe('X_OUTBOUND_THROTTLED');
    expect(throttled.meta?.['headers']).toEqual({ 'x-request-id': 'req_123' });
  });

  test('an asked-for header the answer does not carry leaves an empty record', async () => {
    const error = await caught(
      outbound(call({ refusal: { headers: ['x-request-id'] } }), {
        fetch: answering(400, {}),
        timer: manualTimer(),
      }),
    );
    expect(error.meta?.['headers']).toEqual({});
  });

  test('no refusal.headers: meta.headers is absent, as before', async () => {
    for (const refusal of [undefined, { detail: false }, { schema: declineSchema }]) {
      const error = await caught(
        outbound(call({ refusal }), {
          fetch: answering(400, { 'x-request-id': 'req_123' }),
          timer: manualTimer(),
        }),
      );
      expect(error.meta !== undefined && 'headers' in error.meta).toBe(false);
    }
  });

  test('it combines with schema and detail: false', async () => {
    const error = await caught(
      outbound(
        call({ refusal: { schema: declineSchema, detail: false, headers: ['x-request-id'] } }),
        {
          fetch: recordingFetch(
            () =>
              new Response(JSON.stringify({ error: { decline_code: 'nope' } }), {
                status: 402,
                headers: { 'x-request-id': 'req_1' },
              }),
          ).fetch,
          timer: manualTimer(),
        },
      ),
    );
    expect(error.meta?.['headers']).toEqual({ 'x-request-id': 'req_1' });
    expect(error.meta?.['fields']).toEqual({ error: { decline_code: 'nope' } });
    expect(error.meta?.['detail']).toBe('');
  });

  test('a value is cut at 200 characters', async () => {
    const error = await caught(
      outbound(call({ refusal: { headers: ['x-trace'] } }), {
        fetch: answering(400, { 'x-trace': 'a'.repeat(500) }),
        timer: manualTimer(),
      }),
    );
    expect(error.meta?.['headers']).toEqual({ 'x-trace': 'a'.repeat(200) });
  });

  test('registered value redaction applies to captured headers', async () => {
    redactValues([{ pattern: /private-refusal-value/g, replace: '[redacted]' }]);
    const error = await caught(
      outbound(call({ refusal: { headers: ['x-trace'] } }), {
        fetch: answering(400, { 'x-trace': 'id private-refusal-value' }),
        timer: manualTimer(),
      }),
    );
    expect(error.meta?.['headers']).toEqual({ 'x-trace': 'id [redacted]' });
    expect(JSON.stringify(error.meta?.['headers'])).not.toContain('private-refusal-value');
  });

  test('prototype-named headers are captured as own properties', async () => {
    const error = await caught(
      outbound(call({ refusal: { headers: ['__proto__'] } }), {
        fetch: answering(400, Object.fromEntries([['__proto__', 'trace']])),
        timer: manualTimer(),
      }),
    );
    const headers = error.meta?.['headers'];
    expect(Object.hasOwn(headers as object, '__proto__')).toBe(true);
    expect(JSON.stringify(headers)).toBe('{"__proto__":"trace"}');
  });

  test('valid names at the length limit are kept, longer tokens have a distinct diagnostic', async () => {
    const name = 'x'.repeat(64);
    const accepted = await caught(
      outbound(call({ refusal: { headers: [name] } }), {
        fetch: answering(400, { [name]: 'ok' }),
        timer: manualTimer(),
      }),
    );
    expect(accepted.meta?.['headers']).toEqual({ [name]: 'ok' });
    const sent = recordingFetch(() => new Response('{}', { status: 400 }));
    const refused = await caught(
      outbound(call({ refusal: { headers: ['x'.repeat(65)] } }), {
        fetch: sent.fetch,
        timer: manualTimer(),
      }),
    );
    expect(refused.cause).toContain('64');
    expect(sent.calls).toHaveLength(0);
  });

  test('a credential-named header is refused at the call, before a byte is sent', async () => {
    for (const name of ['Set-Cookie', 'authorization', 'x-api-key', 'WWW-Authenticate']) {
      const sent = recordingFetch(() => new Response('{}', { status: 400 }));
      const error = await caught(
        outbound(call({ refusal: { headers: ['x-request-id', name] } }), {
          fetch: sent.fetch,
          timer: manualTimer(),
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain(name.toLowerCase());
      expect(error.fix).toContain('x-request-id');
      expect(sent.calls).toHaveLength(0);
    }
  });

  test('a malformed option is refused at the call: not an array, too many, not a header name', async () => {
    const bad: unknown[] = [
      'x-request-id',
      Array.from({ length: 17 }, (_, i) => `x-h-${String(i)}`),
      [''],
      ['bad name'],
      ['x-Key'],
      [42],
      ['x'.repeat(65)],
    ];
    for (const headers of bad) {
      const sent = recordingFetch(() => new Response('{}', { status: 400 }));
      const error = await caught(
        outbound(call({ refusal: { headers } as never }), {
          fetch: sent.fetch,
          timer: manualTimer(),
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('refusal.headers');
      expect(sent.calls).toHaveLength(0);
    }
  });
});
