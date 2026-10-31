// The read's input as a search string — the ONE encoding the typed client sends and a download's
// minted URL carries, so the route's `coerceQuery` reads both back the same way. A leaf: the
// browser client imports it, and it imports nothing that registers a code table.

import { isJsonObject } from '@ultimat3/core/page';
import type { PageControls } from './page-controls';
import { PAGE_AFTER_KEY, PAGE_FIRST_KEY } from './page-keys';

/**
 * Input as a query string. Keys are sorted so the same input always produces the
 * same URL — a GET is a cache key, and an unstable one caches nothing.
 *
 * The page controls come LAST, after the sorted input and in a fixed order, so a paged URL is the
 * plain URL with a suffix — the same dedup key for the same page, and a log line a reader can
 * split at `_first=` to recover the read underneath.
 *
 * An EMPTY array sends nothing, and the route reads a required array nobody sent as `[]`
 * (`absentArraysOf`, `input-shape.ts`) — the two halves of one rule, so `{ tags: [] }` arrives.
 */
export function searchOf(input: unknown, page?: PageControls): string {
  const params = new URLSearchParams();
  if (isJsonObject(input)) {
    for (const key of Object.keys(input).sort()) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? (value as readonly unknown[]) : [value]) {
        params.append(key, wireText(item));
      }
    }
  }
  if (page !== undefined) {
    params.append(PAGE_FIRST_KEY, String(page.first));
    if (page.after !== undefined) params.append(PAGE_AFTER_KEY, page.after);
  }
  return params.toString();
}

/**
 * One value as the characters `coerceQuery` reads back. A `Date` is its ISO instant: through
 * `JSON.stringify` it arrived wrapped in quotes, which `t.date` refuses on the far side. An
 * Invalid Date has no instant, and `toISOString()` throws a bare `RangeError` on it, so it is sent
 * as the text it prints and the read's own schema says what is wrong with it.
 */
function wireText(item: unknown): string {
  if (item instanceof Date) return Number.isNaN(item.getTime()) ? String(item) : item.toISOString();
  return typeof item === 'object' ? JSON.stringify(item) : String(item);
}
