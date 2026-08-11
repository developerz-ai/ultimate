// Branded ids and the handle rule. A brand costs nothing at runtime and makes passing a post id
// where a user id belongs a compile error — the mistake that a `string` parameter list invites and
// that no test reliably catches.

declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Branded<string, 'UserId'>;
export type Handle = Branded<string, 'Handle'>;

/** The `@name` in a URL. Lowercase, because a URL that differs only in case is two URLs. */
export const MAX_HANDLE = 30;

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_]{0,28}[a-z0-9])?$/;

/**
 * No leading, trailing or doubled separators, and never all-numeric-looking edge cases that
 * collide with an id in a route. Enforced here AND as a Postgres CHECK, from one declaration.
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
