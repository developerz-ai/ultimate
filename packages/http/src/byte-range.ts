// Single responsibility: one `Range: bytes=…` header against a body of known size, and the window
// of a stream it names. Every route that answers bytes reads ranges here — `/_storage`, the site
// assets, a query's download — because Safari will not play a `<video>` from a source that answers
// 200 to a `Range` probe, and two parsers had already disagreed about an empty `bytes=-`.

/** Inclusive, as `Range` and `Content-Range` both are. */
export interface RequestedRange {
  readonly start: number;
  readonly end: number;
}

/** A range the body cannot satisfy — the route answers 416 with `content-range: bytes *\/<size>`. */
export const RANGE_UNSATISFIABLE = 'unsatisfiable';

/**
 * One range or none. A multi-range or malformed header is ignored rather than refused — RFC 9110
 * lets a server answer the whole representation, and `multipart/byteranges` is a body format no
 * caller of these routes asks for. `bytes=-` names no byte and is ignored the same way.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): RequestedRange | typeof RANGE_UNSATISFIABLE | undefined {
  if (header === null || header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const from = match[1] ?? '';
  const to = match[2] ?? '';
  if (from === '' && to === '') return undefined;
  if (from === '') {
    const wanted = Number(to);
    // A suffix longer than the body is the whole body, not a refusal — but there is no whole body
    // at `size === 0`, and the arithmetic below would answer `{ start: 0, end: -1 }`, which renders
    // as `content-range: bytes 0--1/0` with a 206. RFC 9110 requires 416.
    return size === 0 || wanted === 0
      ? RANGE_UNSATISFIABLE
      : { start: Math.max(size - wanted, 0), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return start >= size || end < start ? RANGE_UNSATISFIABLE : { start, end };
}

/**
 * The inclusive window `[start, end]` of a stream, as a stream: the bytes before `start` are read
 * and dropped — bounded memory, at the cost of reading the prefix, the trade a `Range` probe on a
 * video wants over buffering the whole body. The source is cancelled once `end` has passed.
 */
export function byteWindow(
  source: ReadableStream<Uint8Array>,
  range: RequestedRange,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const from = Math.max(range.start - offset, 0);
        const to = Math.min(range.end + 1 - offset, chunk.byteLength);
        offset += chunk.byteLength;
        if (to > from) controller.enqueue(chunk.subarray(from, to));
        if (offset > range.end) controller.terminate();
      },
    }),
  );
}

/** `bytes 2-5/10` — the `content-range` of a 206. */
export const contentRangeOf = (range: RequestedRange, size: number): string =>
  `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`;
