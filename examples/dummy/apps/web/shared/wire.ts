/**
 * An instant off the typed read client. `queryClient` hands back `response.json()` — the same
 * seam `rpc` uses — and a query declares no output schema to rehydrate with, so a column typed
 * `Date` arrives as the ISO string `JSON.stringify` wrote. Converted at the route's `load`, so
 * nothing downstream calls `toISOString()` on a string or formats one as a date.
 */

/** Overloaded, not `Date | null` everywhere: a non-null column must stay non-null downstream. */
export function wireDate(value: Date | string): Date;
export function wireDate(value: Date | string | null): Date | null;
export function wireDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}
