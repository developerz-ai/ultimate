// `OutboundDeps.fetch`, the transport seam, held to `outbound()`'s own rules: a transport that
// follows a redirect itself — ignoring `init.redirect: 'manual'` — took a hop no screen saw, so
// its answer is refused, under `redirect: 'error'` and `'follow'` alike. A real listener: only
// Bun's `fetch` sets `Response.redirected`, a constructed `Response` never does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { markListening } from './listeners';
import { outbound } from './outbound';
import type { OutboundFetch } from './outbound-types';

let server: ReturnType<typeof Bun.serve> | undefined;
let unannounce = (): void => undefined;
const reached: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      reached.push(path);
      if (path === '/start') return Response.redirect('/inner?token=s3cret', 302);
      return new Response('inner');
    },
  });
  unannounce = markListening(server.url.origin);
});

afterAll(() => {
  unannounce();
  server?.stop(true);
});

/** A transport that drops the `redirect` outbound() sent and follows hops itself. */
const following: OutboundFetch = (url, init) =>
  fetch(url, { ...init, signal: init.signal ?? null, redirect: 'follow' } as RequestInit);

/** A transport that passes `init` through, as the seam asks. */
const passing: OutboundFetch = (url, init) =>
  fetch(url, { ...init, signal: init.signal ?? null } as RequestInit);

const call = (fetchImpl: OutboundFetch, redirect: 'error' | 'follow', path = '/start') =>
  outbound(
    {
      url: `${server?.url.origin ?? ''}${path}`,
      vendor: 'v',
      dial: 'named',
      deadlineMs: 5_000,
      redirect,
    },
    { fetch: fetchImpl },
  ).then(
    (answer) => ({ text: answer.text() }),
    (error: unknown) => {
      if (!isUltimateError(error)) throw error;
      return { code: error.code, meta: error.meta, cause: error.cause };
    },
  );

describe('unit · outbound · the transport seam', () => {
  test('a transport that followed a redirect itself is refused, whatever `redirect` says', async () => {
    for (const redirect of ['error', 'follow'] as const) {
      const refused = await call(following, redirect);
      expect(refused).toMatchObject({ code: 'X_OUTBOUND_TRANSPORT_REDIRECTED' });
      // No status: `outboundResponse()` must never rebuild this refusal as the hop's 200.
      expect((refused as { meta?: Record<string, unknown> }).meta?.['status']).toBeUndefined();
      expect(JSON.stringify(refused)).not.toContain('s3cret');
    }
  });

  test('a transport that passes init through gets outbound()’s own redirect rules', async () => {
    expect(await call(passing, 'error')).toMatchObject({ code: 'X_OUTBOUND_REDIRECTED' });
    // `'follow'` re-screens each hop as public, and loopback is not: the hop outbound() took.
    expect(await call(passing, 'follow')).toMatchObject({ code: 'X_OUTBOUND_HOST_BLOCKED' });
    expect(await call(passing, 'error', '/inner')).toEqual({ text: 'inner' });
  });
});
