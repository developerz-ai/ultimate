// Branded ids and the handle rule. A brand costs nothing at runtime and makes passing a post id
// where a user id belongs a compile error — the mistake that a `string` parameter list invites and
// that no test reliably catches.

declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Branded<string, 'UserId'>;
export type Handle = Branded<string, 'Handle'>;

/** The `@name` in a URL. Lowercase, because a URL that differs only in case is two URLs. */
export const MAX_HANDLE = 30;

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_]{0,28}[a-z0-9])?$/;

/**
 * No leading or trailing separator. It permits a doubled `__` and an all-numeric handle, and this
 * comment claimed otherwise until 2026-08-26 — `HANDLE_RE.test('a__b')` and `.test('123')` are
 * both true. That mattered more once the pattern became a real Postgres CHECK (`users.ts`): a
 * database now enforces exactly this, so a stricter sentence here described a rule nothing had.
 * Tightening the pattern is a separate decision with existing rows behind it; `/u/:handle` does
 * not in fact collide with an id, because ids here are uuids.
 *
 * The CHECK is declared from `HANDLE_RE` directly (`users.ts`), not from this function: a
 * predicate cannot be translated and reports `sql: null`, so passing it here claimed a
 * constraint the database never had. The `length <= MAX_HANDLE` clause stays app-side; the
 * column's own `text({ max })` is what enforces it in SQL.
 */
export const isValidHandle = (value: string): boolean =>
  value.length <= MAX_HANDLE && HANDLE_RE.test(value);

export const handle = (value: string): Handle => value as Handle;

export const userId = (value: string): UserId => value as UserId;

/**
 * A block is symmetric for *visibility* even though the row is directional: if either person has
 * blocked the other, neither sees the other's content. Stated once, here, because a rule that lives
 * in two policies drifts in one of them.
 */
export const BLOCKED_BOTH_WAYS = true;
