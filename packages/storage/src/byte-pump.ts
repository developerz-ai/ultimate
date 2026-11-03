// Single responsibility: the one counting read of a body whose length is the sender's: `put()`
// buffering a stream and `putStream` writing one both come through here. The caller says where the
// chunks go and which refusal the limit raises; none of them decides when the body is too long.

import { assert, describeValue } from '@ultimat3/core';

export interface PumpLimit {
  readonly driver: string;
  readonly maxBytes: number;
  /** The error to throw past `maxBytes`, given how far the body had got. */
  readonly refuse: (total: number) => Error;
}

/**
 * Every chunk handed to `sink` in order, and how many bytes they came to. Past the limit the sink
 * sees nothing more. The reader is cancelled on every way out, so a refused body stops arriving
 * rather than filling a socket buffer nobody will read. An already-closed stream answers that with
 * a no-op.
 */
export async function pumpBounded(
  body: ReadableStream<Uint8Array>,
  limit: PumpLimit,
  sink: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> {
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return total;
      assert(
        next.value instanceof Uint8Array,
        `the stream handed to the ${limit.driver} disk yielded a chunk that is not a Uint8Array (${describeValue(next.value)})`,
        'stream.pipeThrough(new TextEncoderStream())   # bytes, never strings',
      );
      total += next.value.byteLength;
      if (total > limit.maxBytes) throw limit.refuse(total);
      // Awaited only when the sink is async: a needless await is one more turn in which the stream
      // pulls ahead, and a refused body must have pulled as little as possible.
      const pending = sink(next.value);
      if (pending !== undefined) await pending;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
