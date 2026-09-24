// Single responsibility: the log level of the one line the `error-map` stage writes per failed
// request. Every 4xx was logged at `error`, so an alert keyed on error lines paged for a typo'd URL.

/**
 * `error` for 5xx — the server failed. `warn` for 401/403/429 — a refused credential, a refused
 * permission or a limit, each worth seeing in bulk. `info` for every other 4xx — the caller's own
 * mistake, which the problem document already explained to them.
 */
export const errorLogLevel = (status: number): 'error' | 'warn' | 'info' => {
  if (status >= 500) return 'error';
  return status === 401 || status === 403 || status === 429 ? 'warn' : 'info';
};
