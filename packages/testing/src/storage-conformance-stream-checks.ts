// The listing, range and streamed-write half of the `StorageDriver` contract. Lifted from
// `storage/src/driver-parity.test.ts` and `driver-stream-parity.test.ts`: a page that is empty AND
// claims to be complete is a false erasure report, and an overrun that keeps bytes is a leak.

import { expect } from 'bun:test';
import type { StorageCheck, StorageDriverLike } from './storage-conformance-shape';
import {
  bytesOf,
  drain,
  names,
  refusalOf,
  refusedWith,
  scopeOf,
  streamOf,
  textOf,
} from './storage-conformance-shape';

const listed = async (disk: StorageDriverLike, prefix: string): Promise<readonly string[]> => {
  const keys: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await disk.list({ prefix, limit: 1, cursor });
    keys.push(...page.rows.map((row) => row.key));
    expect(page.hasMore).toBe(page.nextCursor !== null);
    if (!page.hasMore) return keys;
    cursor = page.nextCursor;
  }
  return expect.unreachable(`list({ limit: 1 }) under ${prefix} never ended`);
};

export const STORAGE_STREAM_CHECKS: readonly StorageCheck[] = [
  {
    name: 'list pages through every key under a prefix, dot-prefixed ones included',
    async run({ disk }) {
      const scope = scopeOf();
      const keys = [`${scope}.hidden.txt`, `${scope}a.txt`, `${scope}b/c.txt`];
      for (const key of keys) await disk.put(key, bytesOf('x'));
      expect([...(await listed(disk, scope))].sort()).toEqual([...keys].sort());
      expect(await disk.list({ prefix: `${scopeOf()}` })).toEqual({
        rows: [],
        nextCursor: null,
        hasMore: false,
      });
    },
  },
  {
    name: 'a list limit is a page size or X_INVARIANT, never a silently empty page',
    async run({ disk }) {
      const scope = scopeOf();
      await disk.put(`${scope}k`, bytesOf('x'));
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        expect(await refusalOf(() => disk.list({ prefix: scope, limit }))).toBe('X_INVARIANT');
      }
      expect(await disk.list({ prefix: scope, limit: 1 })).toMatchObject({
        nextCursor: null,
        hasMore: false,
      });
    },
  },
  {
    name: 'streamRange is the window get() answers for the same range, clamped at the end',
    async run({ disk }) {
      const key = `${scopeOf()}r.bin`;
      await disk.put(key, bytesOf('0123456789'));
      for (const range of [
        [0, 0],
        [2, 5],
        [9, 9],
      ] as const) {
        const window = await drain(await disk.streamRange(key, range));
        expect(window).toBe(textOf((await disk.get(key, { range })).bytes));
      }
      expect(await drain(await disk.streamRange(key, [7, 1_000_000]))).toBe('789');
      const past = await refusedWith(() => disk.streamRange(key, [10, 12]));
      expect([past.code, names(past, 'fix', 'disk.stat(')]).toEqual([
        'X_STORAGE_RANGE_UNSATISFIABLE',
        true,
      ]);
    },
  },
  {
    name: 'a tuple that is no range is X_INVARIANT before the disk is asked',
    async run({ disk }) {
      const key = `${scopeOf()}r.bin`;
      for (const range of [[5, 2], [-1, 2], [0.5, 2], [0], 'bytes=0-1']) {
        const bad = range as unknown as readonly [number, number];
        const refused = await refusedWith(() => disk.streamRange(key, bad));
        expect([refused.code, names(refused, 'cause', 'streamRange()')]).toEqual([
          'X_INVARIANT',
          true,
        ]);
      }
      expect(await refusalOf(() => disk.streamRange('../up', [0, 1]))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
    },
  },
  {
    name: 'putStream round-trips a body in the one object shape put() answers',
    async run({ disk }) {
      const key = `${scopeOf()}s.txt`;
      const object = await disk.putStream(key, streamOf(bytesOf('hello '), bytesOf('stream')), {
        maxBytes: 64,
        contentType: 'text/plain',
        cacheControl: 'public, max-age=60',
        metadata: { uploadedBy: 'user-1' },
      });
      expect([object.key, object.size, object.contentType]).toEqual([key, 12, 'text/plain']);
      expect([object.cacheControl, object.metadata]).toEqual([
        'public, max-age=60',
        { uploadedBy: 'user-1' },
      ]);
      expect(await drain(await disk.stream(key))).toBe('hello stream');
      expect((await disk.stat(key))?.size).toBe(12);
    },
  },
  {
    name: 'a body across many chunks lands every chunk, in order',
    async run({ disk }) {
      const [size, count, key] = [256 * 1024, 12, `${scopeOf()}big.bin`];
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === count) return controller.close();
          sent += 1;
          controller.enqueue(new Uint8Array(size).fill(sent));
        },
      });
      await disk.putStream(key, body, { maxBytes: size * count });
      const stored = new Uint8Array(await new Response(await disk.stream(key)).arrayBuffer());
      expect(stored.byteLength).toBe(size * count);
      const lasts = Array.from({ length: count }, (_, at) => stored[at * size + size - 1]);
      expect(lasts).toEqual(Array.from({ length: count }, (_, at) => at + 1));
    },
  },
  {
    name: 'an overrun is X_STORAGE_TOO_LARGE, cancels the source and keeps what the key held',
    async run({ disk }) {
      const scope = scopeOf();
      let cancelled = false;
      const endless = new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(bytesOf('0123456789')),
        cancel: () => {
          cancelled = true;
        },
      });
      const overrun = await refusedWith(() =>
        disk.putStream(`${scope}new`, endless, { maxBytes: 16 }),
      );
      expect([overrun.code, names(overrun, 'fix', 'maxBytes')]).toEqual([
        'X_STORAGE_TOO_LARGE',
        true,
      ]);
      expect([cancelled, await disk.exists(`${scope}new`)]).toEqual([true, false]);

      await disk.put(`${scope}old`, bytesOf('previous'));
      const over = streamOf(bytesOf('0123456789'), bytesOf('0123456789'));
      expect(await refusalOf(() => disk.putStream(`${scope}old`, over, { maxBytes: 16 }))).toBe(
        'X_STORAGE_TOO_LARGE',
      );
      expect(textOf((await disk.get(`${scope}old`)).bytes)).toBe('previous');
    },
  },
  {
    name: 'a source that dies mid-body is X_STORAGE_PUT_FAILED and leaves nothing',
    async run({ disk }) {
      const key = `${scopeOf()}dies`;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new TypeError('the client went away'));
          else controller.enqueue(bytesOf('partial'));
          sent = true;
        },
      });
      expect(await refusalOf(() => disk.putStream(key, body, { maxBytes: 64 }))).toBe(
        'X_STORAGE_PUT_FAILED',
      );
      expect(await disk.exists(key)).toBe(false);
    },
  },
  {
    name: 'putStream screens maxBytes, its body, and what needs the bytes up front, by X_INVARIANT',
    async run({ disk }) {
      const key = `${scopeOf()}screened`;
      const refused = (options: unknown, body: unknown = streamOf()) =>
        refusedWith(() =>
          disk.putStream(key, body as ReadableStream<Uint8Array>, options as { maxBytes: number }),
        );
      for (const maxBytes of [undefined, 0, -1, 1.5, Number.NaN]) {
        expect((await refused({ maxBytes })).code).toBe('X_INVARIANT');
      }
      for (const extra of [
        { checksum: 'abc' },
        { legalHold: true },
        { retention: { mode: 'GOVERNANCE', retainUntil: new Date(0) } },
        { serverSideEncryption: { algorithm: 'AES256' } },
      ]) {
        const upFront = await refused({ maxBytes: 64, ...extra });
        expect([upFront.code, names(upFront, 'fix', 'disk.put(')]).toEqual(['X_INVARIANT', true]);
      }
      expect((await refused({ maxBytes: 64, metadata: { n: 1 } })).code).toBe('X_INVARIANT');
      expect((await refused({ maxBytes: 1 }, bytesOf('x'))).code).toBe('X_INVARIANT');
      const strings = new ReadableStream({
        start(controller) {
          controller.enqueue('not bytes');
          controller.close();
        },
      });
      expect((await refused({ maxBytes: 64 }, strings)).code).toBe('X_INVARIANT');
      expect(await disk.exists(key)).toBe(false);
    },
  },
  {
    name: "putStream is bounded by its own maxBytes, never by the disk's put ceiling",
    async run({ disk, maxPutBytes }) {
      // Armed by a subject that names the ceiling its disk was built with.
      if (maxPutBytes === undefined) return;
      const [key, body] = [`${scopeOf()}past-ceiling`, bytesOf('x'.repeat(maxPutBytes + 1))];
      expect(await refusalOf(() => disk.put(key, body))).toBe('X_STORAGE_TOO_LARGE');
      const object = await disk.putStream(key, streamOf(body), { maxBytes: maxPutBytes * 2 });
      expect(object.size).toBe(maxPutBytes + 1);
      expect((await disk.stat(key))?.size).toBe(maxPutBytes + 1);
    },
  },
];
