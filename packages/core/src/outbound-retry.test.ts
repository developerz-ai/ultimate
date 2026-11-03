// `outbound()`'s answers as codes, and which of them are tried again. Measured over raw `fetch` and
// core's `retry()`: a 503 ran `calls 1 status 503` (no throw, no retry), and an unclassified throw
// from a POST ran `attempts 3` — an unsafe write replayed. Each probe is a case here.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import { outbound, outboundResponse } from './outbound';
import { manualTimer, recordedSleep, recordingFetch } from './outbound-fixture';
import type { OutboundRequest } from './outbound-types';
import { retry } from './retry';

// `outbound`'s overloads pick the answer from `read`; a helper typed `OutboundRequest` matches none.
type BytesCall = OutboundRequest & { readonly read?: 'bytes' | undefined };
const call = (over: Partial<BytesCall> = {}): BytesCall => ({
  url: 'https://api.vendor.test/v1/charges?token=sk_live_SECRET',
  vendor: 'vendor',
  dial: 'named',
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

const zero = (): number => 0;

describe('unit · outbound · retry', () => {
  test('the raw probe: retry() over a fetch answering 503 neither throws nor retries', async () => {
    let calls = 0;
    const response = await retry(
      async () => {
        calls += 1;
        return new Response('down', { status: 503 });
      },
      { attempts: 3, base: 1, max: 1, jitter: 'none' },
      { sleep: () => Promise.resolve() },
    );
    expect([calls, response.status]).toEqual([1, 503]);
  });

  test('a 503 is retried, then X_OUTBOUND_UNAVAILABLE naming the status', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('down', { status: 503 }));
    const { sleep, slept } = recordedSleep();
    const error = await caught(
      outbound(call(), { fetch, sleep, random: zero, timer: manualTimer() }),
    );
    expect(error.code).toBe('X_OUTBOUND_UNAVAILABLE');
    expect(error.meta?.['status']).toBe(503);
    expect(calls).toHaveLength(3);
    expect(slept).toHaveLength(2);
  });

  test('a 503 then a 200 answers the 200', async () => {
    const { fetch } = recordingFetch((_call, n) =>
      n === 1 ? new Response('', { status: 503 }) : new Response('ok'),
    );
    const answer = await outbound(call(), { fetch, ...recordedSleep(), timer: manualTimer() });
    expect(answer.text()).toBe('ok');
  });

  test('a stated Retry-After is the delay waited, and the last answer is X_OUTBOUND_THROTTLED', async () => {
    const { fetch } = recordingFetch(
      () => new Response('', { status: 429, headers: { 'retry-after': '2' } }),
    );
    const { sleep, slept } = recordedSleep();
    const error = await caught(
      outbound(call(), { fetch, sleep, random: zero, timer: manualTimer() }),
    );
    expect(error.code).toBe('X_OUTBOUND_THROTTLED');
    expect(error.meta?.['retryAfterSeconds']).toBe(2);
    expect(slept).toEqual([2_000, 2_000]);
  });

  test('a POST is never replayed: one attempt on a dead network, X_OUTBOUND_UNREACHABLE', async () => {
    const { fetch, calls } = recordingFetch(() => Promise.reject(new TypeError('fetch failed')));
    const error = await caught(
      outbound(call({ method: 'POST', body: '{}' }), { fetch, timer: manualTimer() }),
    );
    expect(error.code).toBe('X_OUTBOUND_UNREACHABLE');
    expect(calls).toHaveLength(1);
  });

  test('a retry on a POST without idempotent is refused before anything is sent', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    const policy = { attempts: 3, base: 1, max: 1, jitter: 'none' } as const;
    const error = await caught(
      outbound(call({ method: 'POST', retry: policy }), { fetch, timer: manualTimer() }),
    );
    expect(error.code).toBe('X_OUTBOUND_RETRY_UNSAFE');
    expect(calls).toHaveLength(0);
  });

  test('an idempotent POST is retried as a safe method is', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('', { status: 502 }));
    const error = await caught(
      outbound(call({ method: 'POST', idempotent: true }), {
        fetch,
        ...recordedSleep(),
        timer: manualTimer(),
      }),
    );
    expect(error.code).toBe('X_OUTBOUND_UNAVAILABLE');
    expect(calls).toHaveLength(3);
  });

  test('a 401 is terminal: one call, X_OUTBOUND_REFUSED with a redacted short detail', async () => {
    const body = JSON.stringify({
      error: 'expired',
      access_token: 'tok_LEAKED',
      pad: 'x'.repeat(400),
    });
    const { fetch, calls } = recordingFetch(() => new Response(body, { status: 401 }));
    const error = await caught(outbound(call(), { fetch, timer: manualTimer() }));
    expect(error.code).toBe('X_OUTBOUND_REFUSED');
    expect(calls).toHaveLength(1);
    const detail = String(error.meta?.['detail']);
    expect(detail).toContain('"error":"expired"');
    expect(detail).not.toContain('tok_LEAKED');
    expect(detail.length).toBe(200);
  });

  test('no query string and no header reaches a cause, a fix, meta or the log', async () => {
    const answers = [
      () => new Response('', { status: 503 }),
      () => new Response('', { status: 400 }),
      () => new Response('', { status: 302, headers: { location: '/next?code=SECRET' } }),
      () => Promise.reject(new TypeError('connect ECONNREFUSED ?token=sk_live_SECRET')),
    ];
    for (const answer of answers) {
      const { fetch } = recordingFetch(answer);
      const error = await caught(
        outbound(call({ headers: { authorization: 'Bearer SECRET' }, retry: undefined }), {
          fetch,
          ...recordedSleep(),
          timer: manualTimer(),
        }),
      );
      const printed = JSON.stringify({ cause: error.cause, fix: error.fix, meta: error.meta });
      expect(printed).toContain('https://api.vendor.test/v1/');
      expect(printed).not.toContain('SECRET');
    }
  });
});

describe('unit · outboundResponse', () => {
  test('a refusal comes back as a Response with its status, detail and stated delay', async () => {
    const { fetch } = recordingFetch(
      () => new Response('{"error":"nope"}', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const answer = await outboundResponse(
      call({ retry: { attempts: 1, base: 1, max: 1, jitter: 'none' } }),
      {
        fetch,
        timer: manualTimer(),
      },
    );
    expect(answer.status).toBe(429);
    expect(answer.headers.get('retry-after')).toBe('3');
    const refused = await outboundResponse(call(), {
      fetch: recordingFetch(() => new Response('{"error":"bad"}', { status: 400 })).fetch,
      timer: manualTimer(),
    });
    expect([refused.status, await refused.text()]).toEqual([400, '{"error":"bad"}']);
    const ok = await outboundResponse(call(), {
      fetch: recordingFetch(() => new Response('fine')).fetch,
      timer: manualTimer(),
    });
    expect([ok.status, await ok.text()]).toEqual([200, 'fine']);
  });

  test('no answer at all still throws its code', async () => {
    const { fetch } = recordingFetch(() => Promise.reject(new TypeError('fetch failed')));
    const error = await caught(
      outboundResponse(call({ method: 'POST' }), { fetch, timer: manualTimer() }),
    );
    expect(error.code).toBe('X_OUTBOUND_UNREACHABLE');
  });
});
