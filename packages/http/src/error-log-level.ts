// Single responsibility: the log level of the one line the `error-map` stage writes per failed
// request. Every 4xx was logged at `error`, so an alert keyed on error lines paged for a typo'd URL.

/**
 * Refusals that are routine by construction: `unauthenticated()` — a signed-in page asked by
 * nobody, mostly scanners in production. Marked at the factory, so the same CODE raised by a
 * credential checker that rejected something (`@ultimat3/auth`'s wrong password) stays `warn`.
 */
const routine = new WeakSet<object>();

/** Marks a refusal the `error-map` line logs at `info` whatever its status. Returns it. */
export const routineRefusal = <E extends object>(error: E): E => {
  routine.add(error);
  return error;
};

/**
 * `error` for 5xx — the server failed. `warn` for 401/403/429 — a refused credential, a refused
 * permission or a limit, each worth seeing in bulk. `info` for every other 4xx — the caller's own
 * mistake, which the problem document already explained to them — and for a `routineRefusal`.
 */
export const errorLogLevel = (status: number, error?: unknown): 'error' | 'warn' | 'info' => {
  if (status >= 500) return 'error';
  if (typeof error === 'object' && error !== null && routine.has(error)) return 'info';
  return status === 401 || status === 403 || status === 429 ? 'warn' : 'info';
};
