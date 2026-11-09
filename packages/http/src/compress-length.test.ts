// The declared length decides HOW an answer is coded: whole between the floor and the ceiling,
// as a stream past the ceiling or with no length once the floor is read, never for a feed.
import { describe, expect, test } from 'bun:test';
import { COMPRESS_MAX_BYTES, COMPRESS_MIN_BYTES } from './compress';
import {
  answer,
  asking,
  bytesOf,
  compressAnonymous,
  decoded,
  SOURCE,
  untouchable,
} from './compress-fixture';

describe('the declared length', () => {
  // v31: a stream with no declared length used to leave identity — every NDJSON export, CSV and
  // large JSON answer, uncompressed. It is coded AS a stream now: nothing is read here, the coder
  // runs as the client pulls, and no length is claimed for bytes nobody has counted.
  const streamOf = (parts: readonly string[], type: string, cacheControl = 'public') =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(bytesOf(part));
          controller.close();
        },
      }),
      { headers: { 'content-type': type, 'cache-control': cacheControl } },
    );

  // Unknown length: read until the floor is reached, then code the rest as the client pulls.
  test('an undeclared stream past the floor is gzip, whole, with no length claimed', async () => {
    const rows = Array.from({ length: 400 }, (_, index) => `${index},a,b\n`);
    const out = await compressAnonymous(asking(), streamOf(rows, 'text/csv'));
    expect(out.headers.get('content-encoding')).toBe('gzip');
    expect(out.headers.has('content-length')).toBe(false);
    expect(out.headers.get('vary')).toBe('accept-encoding');
    expect(await decoded(out)).toBe(rows.join(''));
  });

  // `new Response(string)` declares no length in Bun: a tiny body must not pay a gzip header.
  test('an undeclared body under the floor leaves identity, whole, with its length', async () => {
    const out = await compressAnonymous(
      asking(),
      new Response('{"ok":true}', {
        headers: { 'content-type': 'application/json', 'cache-control': 'public' },
      }),
    );
    expect(out.headers.has('content-encoding')).toBe(false);
    expect(out.headers.get('content-length')).toBe('11');
    expect(await out.text()).toBe('{"ok":true}');
  });

  // A feed must deliver each line as it is written; `CompressionStream` emits only its header
  // until the source closes, so an undeclared NDJSON answer is never coded — read nothing, hold
  // nothing. With a declared length it is a document like any other.
  test('an undeclared NDJSON feed stays identity and unread', async () => {
    const quiet = untouchable();
    const source = new Response(quiet.body, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'public' },
    });
    expect(await compressAnonymous(asking(), source)).toBe(source);
    expect(quiet.pulled()).toBe(false);
  });

  test('a declared NDJSON document is coded', async () => {
    const out = await compressAnonymous(
      asking(),
      answer(SOURCE, { 'content-type': 'application/x-ndjson' }),
    );
    expect(out.headers.get('content-encoding')).toBe('gzip');
  });

  test('an undeclared stream that stalls before the floor gives way at the deadline, whole', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(bytesOf('a,b\n'));
      },
    });
    const deadline = new AbortController();
    const pending = compressAnonymous(
      asking(),
      new Response(body, { headers: { 'content-type': 'text/csv', 'cache-control': 'public' } }),
      deadline.signal,
    );
    deadline.abort();
    const out = await pending;
    expect(out.headers.has('content-encoding')).toBe(false);
    source?.enqueue(bytesOf('c,d\n'));
    source?.close();
    expect(await out.text()).toBe('a,b\nc,d\n');
  });

  test('a CSV body is coded too; private and no-store stay identity', async () => {
    const csv = (cacheControl: string) =>
      new Response(SOURCE, {
        headers: { 'content-type': 'text/csv', 'cache-control': cacheControl },
      });
    const coded = await compressAnonymous(asking(), csv('public'));
    expect(coded.headers.get('content-encoding')).toBe('gzip');
    expect(await decoded(coded)).toBe(SOURCE);
    for (const withheld of ['private', 'no-store']) {
      const source = csv(withheld);
      expect(await compressAnonymous(asking(), source)).toBe(source);
    }
  });

  test.each(['abc', '-1', '1e3', ''])('a length of %p is not a length', async (length) => {
    const quiet = untouchable();
    const source = answer(quiet.body, { 'content-length': length });
    expect(await compressAnonymous(asking(), source)).toBe(source);
    expect(quiet.pulled()).toBe(false);
  });

  test('one byte under the floor stays identity, at the floor is coded', async () => {
    const under = answer('x'.repeat(COMPRESS_MIN_BYTES - 1), {
      'content-length': String(COMPRESS_MIN_BYTES - 1),
    });
    expect(await compressAnonymous(asking(), under)).toBe(under);
    const floor = await compressAnonymous(
      asking(),
      answer('x'.repeat(COMPRESS_MIN_BYTES), { 'content-length': String(COMPRESS_MIN_BYTES) }),
    );
    expect(floor.headers.get('content-encoding')).toBe('gzip');
  });

  // Past the ceiling the one-shot `gzipSync` would hold the event loop; the stream coder does not.
  test('at the ceiling is coded whole; one byte over is coded as a stream, never awaited', async () => {
    const ceiling = await compressAnonymous(
      asking(),
      answer('x'.repeat(COMPRESS_MAX_BYTES), { 'content-length': String(COMPRESS_MAX_BYTES) }),
    );
    expect(ceiling.headers.get('content-encoding')).toBe('gzip');
    expect(ceiling.headers.get('content-length')).not.toBeNull();
    const quiet = untouchable();
    const over = answer(quiet.body, { 'content-length': String(COMPRESS_MAX_BYTES + 1) });
    const out = await compressAnonymous(asking(), over);
    expect(out.headers.get('content-encoding')).toBe('gzip');
    expect(out.headers.has('content-length')).toBe(false);
  });

  test('a large body coded as a stream decodes to its source', async () => {
    const big = 'line of a large export\n'.repeat(20_000);
    const out = await compressAnonymous(
      asking(),
      answer(big, { 'content-length': String(bytesOf(big).byteLength) }),
    );
    expect(out.headers.get('content-encoding')).toBe('gzip');
    expect(await decoded(out)).toBe(big);
  });

  test('the bounds are the documented figures', () => {
    expect(COMPRESS_MIN_BYTES).toBe(1_024);
    expect(COMPRESS_MAX_BYTES).toBe(262_144);
  });

  test('a null body stays what it is', async () => {
    const source = answer(null);
    expect(await compressAnonymous(asking(), source)).toBe(source);
  });
});
