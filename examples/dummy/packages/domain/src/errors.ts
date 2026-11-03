/**
 * Domain error codes. Bare `Error` is banned framework-wide; an invariant break must carry the
 * invariant's name and the fix, because it is usually read by an agent, not a human.
 */

// No `docs:` at any declaration below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { defineError } from '@ultimat3/core';

/** 422: every invariant here is a value a caller handed in that the domain cannot hold. */
export const InvariantViolation = defineError<{
  readonly invariant: string;
  readonly cause: string;
  readonly fix: string;
}>({
  code: 'X_DOMAIN_INVARIANT',
  title: 'a domain invariant does not hold',
  status: 422,
  cause: (d) => `${d.invariant}: ${d.cause}`,
  fix: (d) => d.fix,
});
