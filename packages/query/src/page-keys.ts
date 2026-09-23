// The two search-string keys that turn `GET /_x/query/<name>` into a page — and nothing else. A
// leaf apart from `page-controls.ts` because that module refuses a bad value, which means it imports
// this package's `errors.ts`, which registers the whole code table at import: the browser client
// that only SPELLS the keys must not carry it. `page-controls.ts` re-exports both names.

/** `?_first=20` — the page size. Present is what makes the route answer a `Page`. */
export const PAGE_FIRST_KEY = '_first';
/** `?_after=<cursor>` — the signed cursor the previous page's `endCursor` carried. */
export const PAGE_AFTER_KEY = '_after';
