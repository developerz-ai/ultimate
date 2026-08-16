// Single responsibility: reading a request body through a COUNTING reader, so a payload past the
// cap is never held in full. It lives in core because two transports need the identical guarantee
// and cannot share it any other way: `@ultimat3/http` (tier 2) owns `bodyLimitBytes`, and
// `@ultimat3/mcp` (tier 4) serves a bare `Request` that never passes through http's pipeline —
// `await request.json()` there was governed only by Bun's 128 MiB default.

/** What a body read produced: the bytes, or the running total at the moment it went over. */
export type CappedBody = { readonly bytes: Uint8Array } | { readonly over: number };

/**
 * The body, read through the stream and abandoned the instant the running total passes `limit`.
 * `arrayBuffer()`/`json()` materialise first and check after, so a `transfer-encoding: chunked`
 * request — one with no `content-length` for a pre-check to read — allocated its whole payload
 * before the 413 it was going to get anyway. A declared length is a courtesy, not a guard.
 */
export const readWithinLimit = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<CappedBody> => {
  if (body === null) return { bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Cancelled rather than drained: the peer is told to stop sending, and nothing past the
        // cap is ever held. Draining is how a rejected request still costs its full transfer.
        await reader.cancel();
        return { over: total };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
};
