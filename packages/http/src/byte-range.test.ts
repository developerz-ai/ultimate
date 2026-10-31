import { describe, expect, test } from 'bun:test';
import { byteWindow, contentRangeOf, parseByteRange } from './byte-range';

describe('parseByteRange', () => {
  test('the ranges a media element actually sends', () => {
    expect(parseByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseByteRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    // A suffix longer than the object is the whole object.
    expect(parseByteRange('bytes=-99', 10)).toEqual({ start: 0, end: 9 });
  });

  test('unsatisfiable and ignorable are different answers', () => {
    expect(parseByteRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=4-2', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
    // A SUFFIX against a zero-byte object. The non-suffix branch already answered this through
    // `start >= size`; the suffix branch had no such test, so `bytes=-5` on an empty object
    // answered `{ start: 0, end: -1 }` and the route rendered `content-range: bytes 0--1/0` with
    // status 206. RFC 9110 requires 416 — nothing satisfies a range over no bytes at all.
    expect(parseByteRange('bytes=-5', 0)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-1', 0)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-99', 0)).toBe('unsatisfiable');
    // Multi-range, an empty `bytes=-` and nonsense are ignored, not refused: the whole body is a
    // valid answer. The site-asset route used to answer 416 to `bytes=-` and `/_storage` 200.
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeUndefined();
    expect(parseByteRange('bytes=-', 10)).toBeUndefined();
    expect(parseByteRange('items=0-1', 10)).toBeUndefined();
    expect(parseByteRange(null, 10)).toBeUndefined();
    expect(parseByteRange(undefined, 10)).toBeUndefined();
  });
});

describe('byteWindow', () => {
  const chunked = (...parts: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });

  test('cuts the inclusive window out of a stream that crosses chunk boundaries', async () => {
    const window = byteWindow(chunked('012', '3456', '789'), { start: 2, end: 7 });
    expect(await new Response(window).text()).toBe('234567');
  });

  test('stops reading once the window has passed', async () => {
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array([pulled]));
        if (pulled === 1000) controller.close();
      },
    });
    const bytes = new Uint8Array(
      await new Response(byteWindow(source, { start: 0, end: 1 })).arrayBuffer(),
    );
    expect([...bytes]).toEqual([1, 2]);
    expect(pulled).toBeLessThan(10);
  });

  test('contentRangeOf renders the 206 header', () => {
    expect(contentRangeOf({ start: 2, end: 5 }, 10)).toBe('bytes 2-5/10');
  });
});
