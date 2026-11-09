// One case per condition of the rule, each asserting the other side too: a passed-through response
// must be the very object it was handed, and a stream nobody may read is one that fails if pulled.
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no native unlink for a test's temp file.
import { tmpdir } from 'node:os'; // why: Bun has no native reader for the temp directory.
import { join } from 'node:path'; // why: Bun has no native path join.
import { logger, UltimateError } from '@ultimat3/core';

import {
  answer,
  asking,
  bytesOf,
  compressAnonymous,
  decoded,
  SOURCE,
  untouchable,
} from './compress-fixture';

describe('a response that qualifies', () => {
  test('is gzip, decodes to its source, and carries its own length', async () => {
    const coded = await compressAnonymous(asking(), answer());
    expect(coded.headers.get('content-encoding')).toBe('gzip');
    const wire = new Uint8Array(await coded.clone().arrayBuffer());
    expect(coded.headers.get('content-length')).toBe(String(wire.byteLength));
    expect(wire.byteLength).toBe(Bun.gzipSync(bytesOf(SOURCE), { level: 6 }).byteLength);
    expect(await decoded(coded)).toBe(SOURCE);
  });

  test('keeps status and every other header, two cookies still two', async () => {
    const headers = new Headers({
      'content-type': 'text/css',
      'cache-control': 'public, max-age=60',
      'content-length': String(bytesOf(SOURCE).byteLength),
      'x-frame-options': 'DENY',
    });
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const coded = await compressAnonymous(asking(), new Response(SOURCE, { status: 200, headers }));
    expect(coded.status).toBe(200);
    expect(coded.headers.get('x-frame-options')).toBe('DENY');
    expect(coded.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  test('drops accept-ranges: a byte offset into identity bytes means nothing in the coded ones', async () => {
    const coded = await compressAnonymous(asking(), answer(SOURCE, { 'accept-ranges': 'bytes' }));
    expect(coded.headers.get('content-encoding')).toBe('gzip');
    expect(coded.headers.has('accept-ranges')).toBe(false);
  });

  test('weakens a strong etag once and leaves a weak one alone', async () => {
    const strong = await compressAnonymous(asking(), answer(SOURCE, { etag: '"abc"' }));
    expect(strong.headers.get('etag')).toBe('W/"abc"');
    const weak = await compressAnonymous(asking(), answer(SOURCE, { etag: 'W/"abc"' }));
    expect(weak.headers.get('etag')).toBe('W/"abc"');
  });

  test('a file body is read and coded like any other', async () => {
    const path = join(tmpdir(), `compress-${crypto.randomUUID()}.css`);
    await Bun.write(path, SOURCE);
    try {
      const coded = await compressAnonymous(asking(), answer(Bun.file(path)));
      expect(await decoded(coded)).toBe(SOURCE);
    } finally {
      await rm(path);
    }
  });
});

describe('method and status', () => {
  // A HEAD the handler answered with no body cannot be measured, so it is not coded; a HEAD
  // carrying GET's body is (`compress-exposure.test.ts`).
  test.each(['HEAD', 'POST'])('%s with no body to measure stays identity', async (method) => {
    const source = answer(method === 'HEAD' ? null : SOURCE);
    const out = await compressAnonymous(asking('gzip', method), source);
    expect(out).toBe(source);
    expect(out.headers.has('content-encoding')).toBe(false);
  });

  test.each([206, 201, 404])('status %i stays identity', async (status) => {
    const source = answer(SOURCE, {}, { status });
    const out = await compressAnonymous(asking(), source);
    expect(out).toBe(source);
    expect(await out.text()).toBe(SOURCE);
  });
});

describe('accept-encoding', () => {
  test.each([
    ['gzip', true],
    ['GZIP', true],
    ['br, gzip', true],
    ['gzip;q=0.5', true],
    ['gzip ; q=1.0', true],
    ['gzip;q=0', false],
    ['gzip; q=0.000', false],
    ['gzip;q=nonsense', false],
    ['br, deflate', false],
    ['gzipped', false],
    ['*', false],
    [null, false],
  ] as const)('%s coded: %p', async (accept, coded) => {
    const out = await compressAnonymous(asking(accept), answer());
    expect(out.headers.get('content-encoding')).toBe(coded ? 'gzip' : null);
    // Whichever way it went, the next client may want the other: the key is on both.
    expect(out.headers.get('vary')).toBe('accept-encoding');
  });
});

describe("a handler's own coding", () => {
  test('content-encoding stands, untouched and unread', async () => {
    const quiet = untouchable();
    const source = answer(quiet.body, { 'content-encoding': 'br' });
    const out = await compressAnonymous(asking(), source);
    expect(out).toBe(source);
    expect(out.headers.get('content-encoding')).toBe('br');
    expect(quiet.pulled()).toBe(false);
    expect(out.headers.get('vary')).toBe('accept-encoding');
  });

  test('content-range stands: a slice of an identity file is not coded', async () => {
    const source = answer(SOURCE, { 'content-range': 'bytes 0-1/2' });
    const out = await compressAnonymous(asking(), source);
    expect(out).toBe(source);
    expect(out.headers.has('content-encoding')).toBe(false);
  });
});

describe('cache-control', () => {
  // BREACH: a private document reflects a secret beside attacker input.
  test.each([
    'private, max-age=0',
    'no-store',
    'no-cache',
    'public, no-transform',
    'NO-TRANSFORM',
    'private="set-cookie"',
  ])('%s stays identity, unread, with no vary', async (cacheControl) => {
    const quiet = untouchable();
    const source = answer(quiet.body, { 'cache-control': cacheControl });
    const out = await compressAnonymous(asking(), source);
    expect(out).toBe(source);
    expect(quiet.pulled()).toBe(false);
    expect(out.headers.has('vary')).toBe(false);
  });

  test('the same body under a public header does compress', async () => {
    const out = await compressAnonymous(asking(), answer(SOURCE, { 'cache-control': 'public' }));
    expect(out.headers.get('content-encoding')).toBe('gzip');
  });

  test('a directive merely containing the word is no directive', async () => {
    const out = await compressAnonymous(
      asking(),
      answer(SOURCE, { 'cache-control': 'public, x-not-private=1, community="private"' }),
    );
    expect(out.headers.get('content-encoding')).toBe('gzip');
  });
});

describe('content-type', () => {
  test.each([
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/json',
    'application/manifest+json',
    'image/svg+xml',
    'application/xml',
    'text/xml',
    'application/rss+xml',
    'application/atom+xml',
    'text/vtt',
    'application/x-ndjson',
    'text/csv',
    'TEXT/HTML; charset=UTF-8',
  ])('%s is coded', async (type) => {
    const out = await compressAnonymous(asking(), answer(SOURCE, { 'content-type': type }));
    expect(out.headers.get('content-encoding')).toBe('gzip');
  });

  test.each(['text/event-stream', 'image/png', 'font/woff2', 'text/plain', 'application/pdf'])(
    '%s stays identity, unread, with no vary',
    async (type) => {
      const quiet = untouchable();
      const source = answer(quiet.body, { 'content-type': type });
      const out = await compressAnonymous(asking(), source);
      expect(out).toBe(source);
      expect(quiet.pulled()).toBe(false);
      expect(out.headers.has('vary')).toBe(false);
    },
  );

  test('no content-type stays identity', async () => {
    const source = new Response(new TextEncoder().encode(SOURCE), {
      headers: {
        'cache-control': 'public',
        'content-length': String(bytesOf(SOURCE).byteLength),
      },
    });
    source.headers.delete('content-type');
    expect(await compressAnonymous(asking(), source)).toBe(source);
  });
});

describe('a body that disagrees with its declaration', () => {
  let warn: Mock<typeof logger.warn>;
  beforeEach(() => {
    warn = spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });
  const failures = (): readonly unknown[] =>
    warn.mock.calls.filter(([line]) => line === 'http.compress_failed').map(([, fields]) => fields);

  test('a stream longer than it declared arrives whole, identity, and is logged', async () => {
    const parts = [bytesOf('a'.repeat(1_500)), bytesOf('b'.repeat(1_500)), bytesOf('c'.repeat(9))];
    let served = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[served];
        served += 1;
        if (part === undefined) controller.close();
        else controller.enqueue(part);
      },
    });
    const out = await compressAnonymous(asking(), answer(body, { 'content-length': '2000' }));
    expect(out.headers.has('content-encoding')).toBe(false);
    // The declaration was false, so repeating it would truncate the answer it just misdescribed.
    expect(out.headers.has('content-length')).toBe(false);
    expect(await out.text()).toBe(`${'a'.repeat(1_500)}${'b'.repeat(1_500)}ccccccccc`);
    expect(failures().length).toBe(1);
    expect(failures()[0]).toMatchObject({ reason: 'longer-than-declared' });
  });

  test('the buffer stops at the first chunk past the declaration, not at the end', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1_000));
        },
      },
      { highWaterMark: 0 },
    );
    const out = await compressAnonymous(asking(), answer(body, { 'content-length': '2000' }));
    // Two chunks fit, the third overran, and nothing past it was asked for.
    expect(pulls).toBe(3);
    await out.body?.cancel();
  });

  test('a stream shorter than it declared is coded honestly', async () => {
    const out = await compressAnonymous(
      asking(),
      answer(new Blob([SOURCE]).stream(), {
        'content-length': String(bytesOf(SOURCE).byteLength + 50),
      }),
    );
    expect(await decoded(out.clone())).toBe(SOURCE);
    expect(out.headers.get('content-length')).toBe(String((await out.arrayBuffer()).byteLength));
  });

  test('a stream that fails midway fails the identity body, keeping what it sent', async () => {
    const failure = new UltimateError({
      code: 'X_INTERNAL',
      cause: 'the source stream failed',
      fix: 'nothing: test input',
    });
    let served = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (served) controller.error(failure);
        else controller.enqueue(new Uint8Array(1_100));
        served = true;
      },
    });
    const out = await compressAnonymous(asking(), answer(body, { 'content-length': '2000' }));
    expect(out.headers.has('content-encoding')).toBe(false);
    expect(failures()[0]).toMatchObject({ reason: 'read-failed' });
    const reader = out.body?.getReader();
    expect((await reader?.read())?.value?.byteLength).toBe(1_100);
    expect(reader?.read()).rejects.toBe(failure);
  });

  test('a stream that stalls mid-read gives way at the deadline, and still arrives whole', async () => {
    const stop = new AbortController();
    const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: stalled, resolve: reachedStall } = Promise.withResolvers<undefined>();
    let started = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (!started) {
            started = true;
            controller.enqueue(bytesOf('early'));
            return;
          }
          reachedStall(undefined);
          await gate;
          controller.enqueue(bytesOf('late'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const pending = compressAnonymous(
      asking(),
      answer(body, { 'content-length': '2000' }),
      stop.signal,
    );
    await stalled;
    stop.abort();
    const out = await pending;
    expect(out.headers.has('content-encoding')).toBe(false);
    expect(out.headers.has('content-length')).toBe(false);
    expect(failures()[0]).toMatchObject({ reason: 'deadline' });
    release(undefined);
    expect(await out.text()).toBe('earlylate');
  });

  test('a request already out of time waits on nothing, and the body still arrives', async () => {
    const stop = new AbortController();
    stop.abort();
    const out = await compressAnonymous(asking(), answer(SOURCE), stop.signal);
    expect(out.headers.has('content-encoding')).toBe(false);
    expect(failures()[0]).toMatchObject({ reason: 'deadline' });
    expect(await out.text()).toBe(SOURCE);
  });
});

describe('a gzip failure', () => {
  test('answers identity with every byte, logs, and never fails the request', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const broken = spyOn(Bun, 'gzipSync').mockImplementation(() => {
      throw new UltimateError({
        code: 'X_INTERNAL',
        cause: 'the codec failed',
        fix: 'nothing: test input',
      });
    });
    try {
      const out = await compressAnonymous(asking(), answer(SOURCE, { etag: '"abc"' }));
      expect(out.status).toBe(200);
      expect(out.headers.has('content-encoding')).toBe(false);
      // Identity again, so the strong validator was never weakened.
      expect(out.headers.get('etag')).toBe('"abc"');
      expect(out.headers.get('vary')).toBe('accept-encoding');
      expect(await out.text()).toBe(SOURCE);
      expect(warn.mock.calls.filter(([line]) => line === 'http.compress_failed').length).toBe(1);
    } finally {
      broken.mockRestore();
      warn.mockRestore();
    }
  });
});
