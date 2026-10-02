// Single responsibility: the ONE answer to "may a caller read this 5xx code's `cause`?". Moved down
// from `@ultimat3/http`'s `problem-meta.ts` because three renderers send an error off the box — the
// HTTP problem document, the MCP error data and the agent `tool_result` — and only the first asked.
// Tier 0, so `@ultimat3/mcp` and `@ultimat3/ai` (tier 4) can ask it without importing each other.

/**
 * The 5xx codes whose `cause` a caller may read. Every other 5xx document carries the code and the
 * request id and a fixed sentence: `X_DB_STATEMENT_FAILED` has a status row, so the old "blank only
 * what nobody classified" rule served the Postgres message and the SQL statement in a production
 * 500. The framework's four are refusals whose cause IS the instruction — back off, retry.
 */
const FRAMEWORK_PUBLIC_CAUSE: ReadonlySet<string> = new Set([
  'X_DRAINING',
  'X_OVERLOADED',
  'X_FLIGHT_GATE_OVERLOADED',
  'X_TIMEOUT',
]);
const APP_PUBLIC_CAUSE = new Set<string>();

/** Whether a 5xx document for `code` may carry its authored `cause`. */
export const hasPublicCause = (code: string): boolean =>
  FRAMEWORK_PUBLIC_CAUSE.has(code) || APP_PUBLIC_CAUSE.has(code);

/**
 * The WRITE half, and not an app's door: an app declares a public cause through
 * `registerProblemMeta({ CODE: { publicCause: true } })` in `@ultimat3/http`, which refuses a
 * framework-owned code first and then calls this. The set lives here only so the predicate above
 * has one table to read whichever renderer asks.
 */
export const registerPublicCause = (code: string): void => {
  APP_PUBLIC_CAUSE.add(code);
};

/** Test seam. Production registers once at boot and never unregisters. */
export const resetPublicCauses = (): void => {
  APP_PUBLIC_CAUSE.clear();
};
