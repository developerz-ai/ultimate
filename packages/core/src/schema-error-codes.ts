// Single responsibility: register `@ultimat3/schema`'s error codes so their titles render for any
// process that imports `@ultimat3/core` — not just the CLI. `@ultimat3/schema` is tier 0 alongside
// this package, so it cannot call `registerErrorCodes()` itself (that would mean importing core,
// a same-tier import) and this package cannot import schema to read its declarations back (same
// reason, the other direction). The codes below are a deliberate, tested duplicate of
// `SCHEMA_ERROR_CODES` in `packages/schema/src/errors.ts` — `schema-error-codes-pin.test.ts`, in a
// package that may legally import both (`@ultimat3/cli`), asserts them equal so a title edited in
// one place and not the other fails the build instead of quietly disagreeing at runtime.

import { registerErrorCodes } from './error-codes';
import { registerErrorRetry } from './error-retry';

/** Mirrors `SCHEMA_ERROR_CODES` in `packages/schema/src/errors.ts`. Keep the titles identical. */
export const SCHEMA_ERROR_CODE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  X_VALIDATION_FAILED: 'value did not match its schema',
  X_SCHEMA_UNSUPPORTED: 'the active schema provider cannot do this',
  X_SCHEMA_DISCRIMINANT_INVALID: 'a discriminated union member can never be dispatched to',
  X_SCHEMA_DEFAULT_UNSHAREABLE: 'a schema default cannot be copied per parse',
});

// Registered here rather than in `error-codes.ts`'s `CORE_CODE_TITLES` because core does not own
// these codes — `@ultimat3/schema` does — and `registerErrorCodes` is the one mechanism that
// raises `X_ERROR_CODE_DUPLICATE` if a package that DOES own one of them ever tries to register it
// too, which pins ownership even though the titles live in two files.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(SCHEMA_ERROR_CODE_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

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
registerErrorRetry({
  X_VALIDATION_FAILED: 'terminal',
  X_SCHEMA_UNSUPPORTED: 'terminal',
  X_SCHEMA_DISCRIMINANT_INVALID: 'terminal',
  X_SCHEMA_DEFAULT_UNSHAREABLE: 'terminal',
});
