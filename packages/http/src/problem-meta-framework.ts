// The FRAMEWORK's half of `problem-meta.ts`: per framework code, the `meta` keys its problem
// document carries. A framework code's `meta` is operator-only by default (`problem-meta.ts`'s
// header names what lives there), and `registerProblemMeta` refuses every framework code — so
// without this table a refusal whose meta IS the caller's instruction never reached the caller.
//
// One reviewed table, never a per-class or per-instance option: an option on the error would let
// any throw site publish any key, and the rule is that a key crosses only where a reviewer wrote
// it here. `problem-meta-framework.test.ts` holds every row to the rules: a framework code, a 4xx,
// a key an app's own declaration could carry, and no secret-shaped name.

/**
 * Code → the `meta` keys its document carries. A `Map`, read by own key (`APP_ERROR_STATUS`'s
 * reason). A new row names the key's producer, so a rename there fails that package's test.
 */
export const FRAMEWORK_PROBLEM_META: ReadonlyMap<string, readonly string[]> = new Map([
  // `@ultimat3/action`'s `MeterExceededError`: which allowance, its size, and when it resets — so a
  // client can say "100 drafts a day, again at midnight UTC" without parsing `cause`. NOT
  // `retryAfterSeconds` (already the `Retry-After` header) and not the counter's subject, which
  // names a tenant (`meter-problem.test.ts` pins the producer's keys).
  ['X_METER_EXCEEDED', Object.freeze(['meter', 'limit', 'resetsAt'])],
]);
