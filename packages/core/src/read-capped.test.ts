import { describe, expect, test } from 'bun:test';
import { type CappedBody, readWithinLimit } from './read-capped';

const bytes = (...values: readonly number[]): Uint8Array => Uint8Array.from(values);

interface Source {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cancelled: () => number;
}

/** A body whose cancellation is observable, so "the peer was told to stop" is an assertion. */
function source(chunks: readonly Uint8Array[], onCancel?: () => void): Source {
  let cancels = 0;
  let index = 0;
  return {
    cancelled: () => cancels,
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancels += 1;
        onCancel?.();
      },
    }),
  };
}

const over = (body: CappedBody): number | undefined => ('over' in body ? body.over : undefined);
const read = (body: CappedBody): Uint8Array | undefined =>
  'bytes' in body ? body.bytes : undefined;

/**
 * The cap is the contract, so a cap that is not a number is refused HERE and not by each caller in
 * turn: `total > NaN` is false for every chunk, so a non-finite limit does not raise the ceiling —
 * it removes it, and this function's whole promise is that a payload past the cap is never held in
 * full. `@ultimat3/http` reaches it with `bodyLimitBytes` and `@ultimat3/mcp` with its own, both
 * `Number(process.env.…)` as often as a literal; mcp closed it at its own boundary, which is one
 * caller defending itself rather than the function keeping its word.
 */
describe('readWithinLimit refuses a cap that is not a cap', () => {
  const NOT_A_CAP = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5] as const;

  for (const limit of NOT_A_CAP) {
    test(`${String(limit)} is X_INVARIANT, never an unbounded read`, async () => {
      const body = source([bytes(1, 2, 3)]);
      await expect(readWithinLimit(body.stream, limit)).rejects.toThrow(/X_INVARIANT/);
    });
  }

  test('the refusal is raised before a single chunk is pulled', async () => {
    const body = source([bytes(1, 2, 3)]);
    await expect(readWithinLimit(body.stream, Number.NaN)).rejects.toThrow(/X_INVARIANT/);
    // Nothing was read, so nothing was cancelled either: the stream is untouched and the caller
    // can still answer with its own error.
    expect(body.cancelled()).toBe(0);
  });

  test('a null body is refused on the same terms — the cap is wrong either way', async () => {
    await expect(readWithinLimit(null, Number.NaN)).rejects.toThrow(/X_INVARIANT/);
  });

  test('zero is a cap: it accepts nothing, which is a decision an app may make', async () => {
    const body = source([bytes(1)]);
    const result = await readWithinLimit(body.stream, 0);
    expect(over(result)).toBe(1);
  });
});

describe('readWithinLimit', () => {
  test('a null body is zero bytes, never a throw', async () => {
    expect(read(await readWithinLimit(null, 10))).toEqual(new Uint8Array(0));
  });

  test('a body inside the cap comes back whole, in order', async () => {
    const body = source([bytes(1, 2), bytes(3)]);
    expect(read(await readWithinLimit(body.stream, 10))).toEqual(bytes(1, 2, 3));
    // A stream that closed on its own was never refused, so the source sees no cancellation.
    expect(body.cancelled()).toBe(0);
  });

  test('a body past the cap answers the running total and is never held whole', async () => {
    const body = source([bytes(1, 2, 3), bytes(4, 5, 6)]);
    const result = await readWithinLimit(body.stream, 4);
    expect(over(result)).toBe(6);
    // Cancelled, not merely released: a refused body must stop arriving. `@ultimat3/storage`'s
    // `readWithin` states the same rule over the same shape, and the two must not disagree.
    expect(body.cancelled()).toBe(1);
  });

  test('a cancel that rejects still answers over-limit, never a bare stream error', async () => {
    // The one path the two implementations differed on: an unguarded `await reader.cancel()`
    // turned the 413 this function exists to report into whatever the stream threw on the way out.
    const body = source([bytes(1, 2, 3), bytes(4, 5, 6)], () => {
      throw new TypeError('the socket went away mid-cancel');
    });
    expect(over(await readWithinLimit(body.stream, 4))).toBe(6);
  });

  test('a stream that errors mid-read reports ITS failure, not the cleanup', async () => {
    const failure = new TypeError('connection reset');
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    await expect(readWithinLimit(stream, 10)).rejects.toBe(failure);
  });
});
