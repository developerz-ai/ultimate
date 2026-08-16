// Single responsibility: register `@ultimat3/schema`'s error codes so their titles render for any
// process that imports `@ultimat3/core` — not just the CLI. `@ultimat3/schema` is tier 0 alongside
// this package, so it cannot call `registerErrorCodes()` itself (that would mean importing core,
// a same-tier import) and this package cannot import schema to read its declarations back (same
// reason, the other direction). The codes below are a deliberate, tested duplicate of
// `SCHEMA_ERROR_CODES` in `packages/schema/src/errors.ts` — `schema-error-codes-pin.test.ts`, in a
// package that may legally import both (`@ultimat3/cli`), asserts them equal so a title edited in
// one place and not the other fails the build instead of quietly disagreeing at runtime.

import { registerErrorCodes } from './error-codes';

/** Mirrors `SCHEMA_ERROR_CODES` in `packages/schema/src/errors.ts`. Keep the titles identical. */
export const SCHEMA_ERROR_CODE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  X_VALIDATION_FAILED: 'value did not match its schema',
  X_SCHEMA_UNSUPPORTED: 'the active schema provider cannot do this',
  X_SCHEMA_DISCRIMINANT_INVALID: 'a discriminated union member can never be dispatched to',
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
