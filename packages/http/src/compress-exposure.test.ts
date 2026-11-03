// What the `compress` stage must never be made to do for a stranger: code a signed-in answer
// (BREACH), spend more of the event loop than the bound allows, disagree between HEAD and GET, or
// leave a read it gave up on unobserved. The rule's ordinary cases are `compress.test.ts`'s.
import { describe, expect, test } from 'bun:test';
import { COMPRESS_MAX_BYTES, compressResponse } from './compress';

const SOURCE = 'a { color: var(--text); }\n'.repeat(200);
const LENGTH = String(new TextEncoder().encode(SOURCE).byteLength);

const answer = (
  cacheControl: string,
  body: BodyInit | null = SOURCE,
  length: string = LENGTH,
): Response =>
  new Response(body, {
    headers: {
      'content-type': 'text/css',
      'cache-control': cacheControl,
      'content-length': length,
    },
  });

const asking = (method = 'GET'): Request =>
  new Request('http://app.test/x', { method, headers: { 'accept-encoding': 'gzip' } });

describe('a signed-in answer', () => {
  // Each of these reads as no offer to `offersSharedCache`, so `cache-headers` leaves it as the
  // handler wrote it — and none says `private`. The actor is what makes it personal.
  test.each([
    'stale-while-revalidate=60',
    'stale-if-error=60',
    'foo max-age=60',
    'public, max-age=60',
  ])('%s is identity, unread', async (cacheControl) => {
    const source = answer(cacheControl);
    const out = await compressResponse(asking(), source, { anonymous: false });
    expect(out).toBe(source);
    expect(out.headers.has('content-encoding')).toBe(false);
    expect(out.bodyUsed).toBe(false);
  });

  test('the same header for an anonymous caller is coded', async () => {
    const out = await compressResponse(asking(), answer('stale-while-revalidate=60'), {
      anonymous: true,
    });
    expect(out.headers.get('content-encoding')).toBe('gzip');
  });

  test('immutable is coded whoever asks: its body is a function of the URL alone', async () => {
    const out = await compressResponse(asking(), answer('public, max-age=31536000, immutable'), {
      anonymous: false,
    });
    expect(out.headers.get('content-encoding')).toBe('gzip');
  });
});

describe('the ceiling', () => {
  // Measured 2026-11-03, `Bun.gzipSync` level 6, high-entropy text (the worst case), median of
  // 15: 2.35 ms at 256 KiB, 9.58 ms at 1 MiB on this machine, about 29 ms at 1 MiB on the audit's.
  test('is 256 KiB, so one request holds the loop a quarter of what 1 MiB did', () => {
    expect(COMPRESS_MAX_BYTES).toBe(262_144);
  });

  test('a body one byte over is identity', async () => {
    const big = 'x'.repeat(COMPRESS_MAX_BYTES + 1);
    const source = answer('public, max-age=60', big, String(big.length));
    expect(await compressResponse(asking(), source, { anonymous: true })).toBe(source);
  });
});

describe('HEAD', () => {
  test('carries the headers GET would, coded, and no body', async () => {
    const get = await compressResponse(asking('GET'), answer('public, max-age=60'), {
      anonymous: true,
    });
    const head = await compressResponse(asking('HEAD'), answer('public, max-age=60'), {
      anonymous: true,
    });
    expect(head.headers.get('content-encoding')).toBe('gzip');
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect(head.headers.get('vary')).toBe(get.headers.get('vary'));
    expect(head.body).toBeNull();
  });
});

/**
 * A body that serves one chunk, then stalls until `fail()` errors it. Nobody pulls it after the
 * stage gives up: the client went away. An unobserved read on it then fails this test by itself,
 * which is `bun test`'s own verdict on an unhandled rejection, so no listener is installed here.
 */
const failingLater = (first: boolean) => {
  const { promise: stalled, resolve: reachedStall } = Promise.withResolvers<undefined>();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let started = !first;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        source = controller;
        if (!started) {
          started = true;
          controller.enqueue(new Uint8Array(10));
          return;
        }
        reachedStall(undefined);
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    stalled,
    fail: () => source?.error(new RangeError('the source failed after the client left')),
  };
};

/** The runtime reports an unhandled rejection once the microtask queue drains: three turns. */
const turns = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

// Pinned against the replay's eager first pull as much as the guard: with a high-water mark of 0
// on the replay and no `pending.catch`, the second case fails (checked 2026-11-03).
describe('a read given up at the deadline', () => {
  test('mid-read: the abandoned read failing later is no unhandled rejection', async () => {
    const source = failingLater(true);
    const stop = new AbortController();
    const pending = compressResponse(asking(), answer('public', source.body, '2000'), {
      anonymous: true,
      signal: stop.signal,
    });
    await source.stalled;
    stop.abort();
    const out = await pending;
    expect(out.headers.has('content-encoding')).toBe(false);
    source.fail();
    await turns();
  });

  test('already out of time: the first read failing later is no unhandled rejection', async () => {
    const source = failingLater(false);
    const stop = new AbortController();
    stop.abort();
    const out = await compressResponse(asking(), answer('public', source.body, '2000'), {
      anonymous: true,
      signal: stop.signal,
    });
    expect(out.headers.has('content-encoding')).toBe(false);
    await source.stalled;
    source.fail();
    await turns();
  });
});
