// The coded-body memo: its bounds on its own, then in the stage — pinned by how many times the
// coder runs (a work count), never by how long a request took.
import { afterEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { compressResponse } from './compress';
import { createCompressCache } from './compress-cache';
import { answer, asking, decoded, SOURCE, untouchable } from './compress-fixture';

const bytes = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(n);

describe('createCompressCache', () => {
  test('keeps what fits and gives back the same bytes', () => {
    const cache = createCompressCache({ maxEntries: 4, maxBytes: 1_000 });
    const body = bytes(10);
    cache.set('a', body);
    expect(cache.get('a')).toBe(body);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  test('past its entry bound the least recently used goes first', () => {
    const cache = createCompressCache({ maxEntries: 2, maxBytes: 1_000 });
    cache.set('a', bytes(1));
    cache.set('b', bytes(1));
    cache.get('a');
    cache.set('c', bytes(1));
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.size).toBe(2);
  });

  test('past its byte bound it evicts until the new body fits; one too big is never kept', () => {
    const cache = createCompressCache({ maxEntries: 100, maxBytes: 100 });
    cache.set('a', bytes(40));
    cache.set('b', bytes(40));
    cache.set('c', bytes(40));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(100);
    cache.set('huge', bytes(101));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  test('a replacement gives its old weight back', () => {
    const cache = createCompressCache({ maxEntries: 10, maxBytes: 100 });
    cache.set('a', bytes(60));
    cache.set('a', bytes(30));
    expect(cache.bytes).toBe(30 + 'a'.length);
    expect(cache.size).toBe(1);
  });
});

describe('the compress stage with a cache', () => {
  let gzip: Mock<typeof Bun.gzipSync> | undefined;
  afterEach(() => gzip?.mockRestore());

  const ETAG = '"css-1"';
  const run = (
    cache: ReturnType<typeof createCompressCache>,
    response: Response,
    { anonymous = true, url = 'http://app.test/x' } = {},
  ) =>
    compressResponse(new Request(url, { headers: asking().headers }), response, {
      anonymous,
      cache,
    });

  test('the same strong ETag served twice is coded once, and the hit leaves the body unread', async () => {
    gzip = spyOn(Bun, 'gzipSync');
    const cache = createCompressCache();
    const first = await run(cache, answer(SOURCE, { etag: ETAG }));
    const quiet = untouchable();
    const second = await run(cache, answer(quiet.body, { etag: ETAG }));
    expect(gzip).toHaveBeenCalledTimes(1);
    expect(quiet.pulled()).toBe(false);
    expect(second.headers.get('content-encoding')).toBe('gzip');
    expect(second.headers.get('content-length')).toBe(first.headers.get('content-length'));
    expect(second.headers.get('etag')).toBe(`W/${ETAG}`);
    expect(await decoded(second)).toBe(SOURCE);
  });

  test('another URL with the same tag is another entry', async () => {
    gzip = spyOn(Bun, 'gzipSync');
    const cache = createCompressCache();
    await run(cache, answer(SOURCE, { etag: ETAG }), { url: 'http://app.test/a' });
    await run(cache, answer(SOURCE, { etag: ETAG }), { url: 'http://app.test/b' });
    expect(gzip).toHaveBeenCalledTimes(2);
  });

  test('a weak or absent validator is coded every time', async () => {
    gzip = spyOn(Bun, 'gzipSync');
    const cache = createCompressCache();
    for (const headers of [{ etag: 'W/"css-1"' }, { etag: 'W/"css-1"' }, {}, {}]) {
      await run(cache, answer(SOURCE, headers));
    }
    expect(gzip).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(0);
  });

  test('an answer with no public directive is never kept', async () => {
    gzip = spyOn(Bun, 'gzipSync');
    const cache = createCompressCache();
    const unshared = { etag: ETAG, 'cache-control': 'max-age=60' };
    await run(cache, answer(SOURCE, unshared));
    await run(cache, answer(SOURCE, unshared));
    expect(gzip).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  test('a signed-in answer is never kept, however public its header', async () => {
    gzip = spyOn(Bun, 'gzipSync');
    const cache = createCompressCache();
    await run(cache, answer(SOURCE, { etag: ETAG }), { anonymous: false });
    await run(cache, answer(SOURCE, { etag: ETAG }), { anonymous: false });
    expect(gzip).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });
});
