// An `immutable` answer coded once, off the loop, at the strongest settings: the store on its own
// (pinned by how many times a coder runs, never by a clock), then through the `compress` stage.

import { afterEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
// why: Bun has no native brotli decoder; `node:zlib` is the test's reader of the stage's bytes.
import { brotliDecompressSync } from 'node:zlib';
import { compressResponse } from './compress';
import { answer, bytesOf, SOURCE } from './compress-fixture';
import {
  createPrecodeStore,
  PRECODERS,
  type Precoding,
  precodeKey,
  precodingAccepted,
} from './compress-precode';

/** The real coders, counted. */
const counted = () => {
  const runs: Precoding[] = [];
  const coders = {
    br: (bytes: Uint8Array<ArrayBuffer>) => {
      runs.push('br');
      return PRECODERS.br(bytes);
    },
    zstd: (bytes: Uint8Array<ArrayBuffer>) => {
      runs.push('zstd');
      return PRECODERS.zstd(bytes);
    },
    gzip: (bytes: Uint8Array<ArrayBuffer>) => {
      runs.push('gzip');
      return PRECODERS.gzip(bytes);
    },
  };
  return { runs, coders };
};

const BYTES = bytesOf(SOURCE);
const KEY = precodeKey('http://app.test/styles/a.css', BYTES);

// A foreign failure handed to the subject: test input, never its verdict.
const SYNC_CODER_FAILURE = new RangeError('coder under test');

describe('precodingAccepted', () => {
  const all = () => true;
  test('a browser that names all three gets brotli; weights still win', () => {
    expect(precodingAccepted('gzip, deflate, br, zstd', all)).toBe('br');
    expect(precodingAccepted('br;q=0.5, gzip', all)).toBe('gzip');
    expect(precodingAccepted('br;q=0, zstd', all)).toBe('zstd');
  });

  test('only what was kept, and nothing for a header naming none of it', () => {
    expect(precodingAccepted('br, gzip', (coding) => coding === 'gzip')).toBe('gzip');
    expect(precodingAccepted('deflate, *', all)).toBeUndefined();
    expect(precodingAccepted(null, all)).toBeUndefined();
  });
});

describe('precodeKey', () => {
  test('a forged Host is the same key; other bytes at the same path are not', () => {
    expect(precodeKey('http://evil.test/styles/a.css', BYTES)).toBe(KEY);
    expect(precodeKey('http://app.test/styles/a.css', bytesOf(`${SOURCE} `))).not.toBe(KEY);
  });
});

describe('createPrecodeStore', () => {
  test('nothing until scheduled; then every coding, each once, however often it is asked', async () => {
    const { runs, coders } = counted();
    const store = createPrecodeStore({ coders });
    expect(store.pick(KEY, 'br, gzip')).toBeUndefined();
    store.schedule(KEY, BYTES);
    store.schedule(KEY, BYTES);
    await store.idle();
    store.schedule(KEY, BYTES);
    await store.idle();
    expect(runs.sort()).toEqual(['br', 'gzip', 'zstd']);
    const br = store.pick(KEY, 'gzip, br');
    expect(br?.coding).toBe('br');
    expect(new TextDecoder().decode(brotliDecompressSync(br?.body ?? new Uint8Array()))).toBe(
      SOURCE,
    );
    expect(store.pick(KEY, 'gzip')?.coding).toBe('gzip');
    expect(store.pick(KEY, 'identity')).toBeUndefined();
  });

  test('at most `concurrency` keys code at once; the rest wait for a later hit', async () => {
    const { runs, coders } = counted();
    const store = createPrecodeStore({ coders, concurrency: 1 });
    store.schedule(KEY, BYTES);
    store.schedule(precodeKey('http://app.test/styles/b.css', BYTES), BYTES);
    await store.idle();
    expect(runs).toHaveLength(3);
  });

  test('a coder that fails keeps nothing for its coding and the others still land', async () => {
    const store = createPrecodeStore({
      coders: { ...PRECODERS, br: () => Promise.reject(new RangeError('coder under test')) },
    });
    store.schedule(KEY, BYTES);
    await store.idle();
    expect(store.pick(KEY, 'br')).toBeUndefined();
    expect(store.pick(KEY, 'br, zstd')?.coding).toBe('zstd');
  });

  test('a coder that throws synchronously is the same failure, never an unhandled rejection', async () => {
    const store = createPrecodeStore({
      coders: {
        ...PRECODERS,
        br: () => {
          throw SYNC_CODER_FAILURE;
        },
      },
    });
    store.schedule(KEY, BYTES);
    await store.idle();
    expect(store.pick(KEY, 'br')).toBeUndefined();
    expect(store.pick(KEY, 'br, zstd')?.coding).toBe('zstd');
  });
});

describe('the compress stage serves the precoded body', () => {
  let gzip: Mock<typeof Bun.gzipSync> | undefined;
  afterEach(() => {
    gzip?.mockRestore();
    gzip = undefined;
  });

  // Signed in by default: an island chunk is the same bytes for everyone, and app/ is signed in.
  const hit = (
    accept: string,
    precode: ReturnType<typeof createPrecodeStore>,
    headers = {},
    anonymous = false,
  ) =>
    compressResponse(
      new Request('http://app.test/styles/a.css', { headers: { 'accept-encoding': accept } }),
      answer(SOURCE, headers),
      { anonymous, precode },
    );

  test('the first hit is coded as before; every later one is a lookup, brotli when accepted', async () => {
    gzip = spyOn(Bun, 'gzipSync');
    const precode = createPrecodeStore();
    const first = await hit('gzip, br', precode);
    expect(first.headers.get('content-encoding')).toBe('gzip');
    await precode.idle();
    const second = await hit('gzip, br', precode);
    const third = await hit('gzip', precode);
    expect(gzip).toHaveBeenCalledTimes(1);
    expect(second.headers.get('content-encoding')).toBe('br');
    expect(second.headers.get('vary')).toContain('accept-encoding');
    const body = new Uint8Array(await second.arrayBuffer());
    expect(second.headers.get('content-length')).toBe(String(body.byteLength));
    expect(new TextDecoder().decode(brotliDecompressSync(body))).toBe(SOURCE);
    expect(third.headers.get('content-encoding')).toBe('gzip');
    expect(
      new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await third.arrayBuffer()))),
    ).toBe(SOURCE);
  });

  test('identity for a client that names no coding, precoded or not', async () => {
    const precode = createPrecodeStore();
    await hit('gzip', precode);
    await precode.idle();
    const plain = await hit('identity', precode);
    expect(plain.headers.has('content-encoding')).toBe(false);
    expect(await plain.text()).toBe(SOURCE);
  });

  test('an answer that is not immutable is never precoded', async () => {
    const { runs, coders } = counted();
    const precode = createPrecodeStore({ coders });
    const coded = await hit('gzip', precode, { 'cache-control': 'public, max-age=60' }, true);
    expect(coded.headers.get('content-encoding')).toBe('gzip');
    await precode.idle();
    expect(runs).toEqual([]);
  });

  test('a strong validator stays with the per-URL memo, which never reads the body', async () => {
    const { runs, coders } = counted();
    const precode = createPrecodeStore({ coders });
    await compressResponse(
      new Request('http://app.test/styles/a.css', { headers: { 'accept-encoding': 'gzip' } }),
      answer(SOURCE, { etag: '"css-1"' }),
      { anonymous: true, precode },
    );
    await precode.idle();
    expect(runs).toEqual([]);
  });
});
