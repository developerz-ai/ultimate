// The one place a framework error code becomes an HTTP status — a table, so a missing row is a
// loud 500 rather than a silently wrong 200. The rows live in one slice per tier
// (`error-map-tier-<n>.ts`, `error-map-http.ts` for this package's own) and are composed here;
// `scripts/new-error-code.ts` appends to the slice. Reading the table is `error-status.ts`.

import { HTTP_ERROR_STATUS } from './error-map-http';
import { TIER_0_ERROR_STATUS } from './error-map-tier-0';
import { TIER_1_ERROR_STATUS } from './error-map-tier-1';
import { TIER_2_ERROR_STATUS } from './error-map-tier-2';
import { TIER_3_ERROR_STATUS } from './error-map-tier-3';
import { TIER_4_ERROR_STATUS } from './error-map-tier-4';

/** Every slice, in composition order — `error-map.test.ts` holds them disjoint. */
export const ERROR_STATUS_SLICES = Object.freeze([
  HTTP_ERROR_STATUS,
  TIER_0_ERROR_STATUS,
  TIER_1_ERROR_STATUS,
  TIER_2_ERROR_STATUS,
  TIER_3_ERROR_STATUS,
  TIER_4_ERROR_STATUS,
] as const);

/**
 * code -> status. Codes owned by other packages are listed here on purpose: HTTP
 * is the only layer that knows what a status means, so no other package should
 * ever hardcode one.
 */
export const ERROR_STATUS = {
  ...HTTP_ERROR_STATUS,
  ...TIER_0_ERROR_STATUS,
  ...TIER_1_ERROR_STATUS,
  ...TIER_2_ERROR_STATUS,
  ...TIER_3_ERROR_STATUS,
  ...TIER_4_ERROR_STATUS,
  // The keys are LITERAL — deliberately not `Readonly<Record<string, number>>`, which is what the
  // annotation used to say. This table is the closed one, so `ERROR_STATUS.X_QUERY_NOT_PAGABLE`
  // has to be a compile error rather than an `undefined` a test then asserts `toBeNumber()` on.
  // Read it by a code the framework did not mint through `statusFor`, never by index.
} satisfies Readonly<Record<string, number>>;
