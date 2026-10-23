// Bun's socket `idleTimeout`, derived from the request deadline. Unset, Bun closes any socket
// whose handler has written nothing for 10 s — so `requestTimeoutMs: 30_000` was a promise the
// runtime broke at 10, and a 25 s long-poll behind a tunnel came back a 502 every time.

/** The longest `idleTimeout` Bun accepts, in seconds. */
export const BUN_MAX_IDLE_TIMEOUT_S = 255;

/**
 * Seconds the socket outlives the deadline, so the pipeline's own `X_TIMEOUT` answer is what the
 * caller reads at the deadline — never a reset that raced it.
 */
export const IDLE_TIMEOUT_MARGIN_S = 2;

/**
 * The `idleTimeout` (seconds) a server needs so its socket never closes before `requestTimeoutMs`
 * answers. `0` is Bun's "disabled", and is the answer twice: for `requestTimeoutMs: 0` (no
 * deadline, so no idle cut either), and for a deadline past what Bun can hold — clamping to 255
 * would re-open this same bug for every deadline above ~4 minutes, so the deadline alone cuts.
 */
export const socketIdleTimeoutSeconds = (requestTimeoutMs: number): number => {
  if (!(requestTimeoutMs > 0)) return 0;
  const seconds = Math.ceil(requestTimeoutMs / 1_000) + IDLE_TIMEOUT_MARGIN_S;
  return seconds > BUN_MAX_IDLE_TIMEOUT_S ? 0 : seconds;
};
