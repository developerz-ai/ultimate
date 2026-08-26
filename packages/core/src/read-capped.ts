// Single responsibility: reading a request body through a COUNTING reader, so a payload past the
// cap is never held in full. It lives in core because two transports need the identical guarantee
// and cannot share it any other way: `@ultimat3/http` (tier 2) owns `bodyLimitBytes`, and
// `@ultimat3/mcp` (tier 4) serves a bare `Request` that never passes through http's pipeline —
// `await request.json()` there was governed only by Bun's 128 MiB default.

import { assert } from './assert';

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
  // The cap is this function's whole contract, so it is screened here and not by each caller in
  // turn. `total > NaN` is false for every chunk, so a non-finite limit does not RAISE the ceiling
  // — it removes it, and the payload the caller was promised would never be held in full is held
  // in full. Both callers reach it from configuration (`@ultimat3/http`'s `bodyLimitBytes`,
  // `@ultimat3/mcp`'s own), and `Number(process.env.…)` on an unset variable is `NaN`. Before the
  // body is touched: a cap this wrong is the caller's bug, not the peer's, and cancelling their
  // stream over it would be answering the wrong party.
  assert(
    Number.isSafeInteger(limit) && limit >= 0,
    `readWithinLimit was given a limit of ${String(limit)}; a byte cap is a whole number of zero or more, and every comparison against a non-finite one is false, so the read is unbounded rather than capped`,
    "pass a whole number of bytes — readWithinLimit(request.body, 1_048_576) — and parse an environment value before you pass it: Number(process.env.BODY_LIMIT_BYTES ?? '') is NaN when the variable is unset",
  );
  if (body === null) return { bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Cancelled rather than drained, in the `finally` below: the peer is told to stop sending,
      // and nothing past the cap is ever held. Draining is how a rejected request still costs its
      // full transfer.
      if (total > limit) return { over: total };
      chunks.push(value);
    }
  } finally {
    // Cancel rather than merely release — `@ultimat3/storage`'s `readWithin` is the same bounded
    // read and states the same rule: a refused body must stop arriving, not keep filling a socket
    // buffer nobody will read. Swallowed, because a cancellation that fails on the way out must
    // not replace the answer this function computed: an unguarded `cancel()` turned the 413 into
    // whatever the stream threw. A completed stream answers it as a no-op.
    await reader.cancel().catch(() => undefined);
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
