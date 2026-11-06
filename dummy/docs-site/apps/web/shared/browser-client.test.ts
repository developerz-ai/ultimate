// The island's typed clients reach the server the way the server serves it: an action is a POST to
// its derived path on the page's own origin, a read is a GET under /_x/query. Asserted on the wire
// — the one place a renamed action or a moved origin would show.
import { expect, unitTest } from '@ultimat3/testing';
import { browserClient } from './browser-client';

interface Sent {
  readonly method: string | undefined;
  readonly url: string;
}

/** Runs `call` against a `fetch` that records each request and answers with `respond()`. */
async function recording<T>(
  respond: () => Response,
  call: () => Promise<T>,
): Promise<{ readonly answer: T; readonly requests: readonly Sent[] }> {
  const requests: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method, url });
    return respond();
  }) as typeof fetch;
  try {
    return { answer: await call(), requests };
  } finally {
    globalThis.fetch = real;
  }
}

unitTest('browserClient posts an action to its derived path on the page origin', async () => {
  const seen = await recording(
    () => Response.json({ ok: true, role: 'web' }),
    () => browserClient.health({}),
  );
  expect(seen.answer).toEqual({ ok: true, role: 'web' });
  expect(seen.requests).toEqual([{ method: 'POST', url: '/api/healths/invoke' }]);
});
