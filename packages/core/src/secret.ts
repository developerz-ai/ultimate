// Single responsibility: a value that cannot be printed by accident. Key-name redaction only
// catches a secret travelling under a name someone remembered to list; a `Secret` box redacts by
// VALUE, so the same string is safe in a log line, an error `meta`, a manifest and a snapshot.

export const REDACTED = '[redacted]';

/**
 * Structural brand, not `instanceof`: two copies of `@ultimat3/core` in one dependency tree must
 * still recognise each other's secrets, or redaction silently stops applying at the seam.
 */
export const SECRET_BRAND: unique symbol = Symbol.for('ultimate.secret');

/** Bun and Node both honour this when rendering a value in `console.log`. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export interface Secret {
  readonly [SECRET_BRAND]: true;
  /** Non-secret name for the value — the env key, the config field. Safe to print. */
  readonly label: string;
  toString(): string;
  toJSON(): string;
}

interface SecretInternal extends Secret {
  reveal(): string;
}

const hidden = (value: unknown): PropertyDescriptor => ({
  value,
  enumerable: false,
  writable: false,
  configurable: false,
});

/**
 * Box a value so every serialisation path renders `[redacted]`: `String()`, template literals,
 * `+`, `JSON.stringify`, `console.log`, and the logger. `revealSecret()` is the only way out, and
 * it is a free function on purpose — one greppable call site per place a secret is actually used.
 *
 * Everything except `label` is non-enumerable, so `{ ...token }`, `Object.entries(token)` and a
 * structured-clone of it cannot carry the value back out of the box.
 */
export function secret(value: string, label = 'secret'): Secret {
  const boxed = Object.defineProperties({ label } as { label: string }, {
    [SECRET_BRAND]: hidden(true),
    reveal: hidden(() => value),
    toString: hidden(() => REDACTED),
    toJSON: hidden(() => REDACTED),
    [INSPECT]: hidden(() => REDACTED),
    [Symbol.toPrimitive]: hidden(() => REDACTED),
  }) as unknown as SecretInternal;
  return Object.freeze(boxed);
}

export function isSecret(value: unknown): value is Secret {
  return typeof value === 'object' && value !== null && SECRET_BRAND in value;
}

/** The one documented way to read a secret. Every call site is a place worth reviewing. */
export function revealSecret(value: Secret): string {
  return (value as SecretInternal).reveal();
}

/** Reveal only when there is something to reveal — for optional configuration. */
export function revealOptionalSecret(value: Secret | undefined): string | undefined {
  return value === undefined ? undefined : revealSecret(value);
}
