// Single responsibility: register `@ultimat3/schema`'s error codes so their titles render for any
// process that imports `@ultimat3/core` — not just the CLI. `@ultimat3/schema` is tier 0 alongside
// this package and cannot call `registerErrorCodes()` itself: that would be `schema -> core`, an
// import this package's own dependency-free promise forbids in that direction and always will.
// The other direction is DECLARED (`core -> schema`, `scripts/lib/tiers.ts`), so the titles are
// READ from schema rather than restated here.
//
// They were a hand-kept duplicate until 2026-08-27, held equal by `schema-error-codes-pin.test.ts`
// in `@ultimat3/cli` — a tier-5 package pinning a tier-0 invariant, which nothing required to
// exist. It is deleted with this change.

import { SCHEMA_ERROR_CODES } from '@ultimat3/schema';
import { registerErrorCodes } from './error-codes';
import { registerErrorRetry } from './error-retry';

/**
 * Schema's own declarations, projected to titles. Kept as an export because it is public API
 * shipped since 1.0; it is now DERIVED and can no longer disagree with its source.
 */
export const SCHEMA_ERROR_CODE_TITLES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SCHEMA_ERROR_CODES).map(([code, declared]) => [code, declared.title]),
  ),
);

// Registered here rather than in `error-codes.ts`'s `CORE_CODE_TITLES` because core does not own
// these codes — `@ultimat3/schema` does — and `registerErrorCodes` is the one mechanism that
// raises `X_ERROR_CODE_DUPLICATE` if a package that DOES own one of them ever tries to register it
// too, which pins ownership even though the registration happens here.
registerErrorCodes(SCHEMA_ERROR_CODES);

// And how each is RETRIED, here for the same tier reason the titles are here.
//
// Every one is LISTED rather than left to the default, which is the lesson `packages/jobs/src/
// errors.ts` writes up for its own six terminal webhook codes: `classifyThrown` reads an
// unregistered code as UNCLASSIFIED, so the attempt count governs and a schema refusal raised
// inside a job body burns the whole retry policy re-proving an answer no attempt can change.
//
// Measured cost before this: `@ultimat3/scraping` spent FIVE browser launches on a page carrying
// a `<div constructor="...">` — five navigations, five arrivals at a login — and dead-lettered
// reporting that the browser went away, about a browser that answered perfectly.
// `packages/scraping/src/cdp-target.ts` names the gap and says it cannot be closed from there.
//
// A value that does not match its schema does not match it on attempt five either.
//
// DERIVED from the same set, so a code schema adds cannot arrive unclassified: the list was typed
// out here and a fifth code would have been silently missing from it, which is precisely the
// "unregistered reads as unclassified" failure the paragraph above describes.
registerErrorRetry(
  Object.fromEntries(Object.keys(SCHEMA_ERROR_CODES).map((code) => [code, 'terminal' as const])),
);
