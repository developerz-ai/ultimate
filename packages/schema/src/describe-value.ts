// Single responsibility: render a REJECTED value as its shape, and the `expected X, received Y`
// line every builtin validator fails with. Its whole job is the rule in `describeValue`'s doc
// comment — the rejected value's content never appears in an issue message. Its own file so that
// rule has one place to live and one test file to enforce it.

/**
 * The shape of a rejected value — **never its content**.
 *
 * WHY: an issue message is not a private diagnostic. `@ultimat3/http` folds these messages into
 * `X_BODY_INVALID`'s `cause`, which is returned to the caller AND written to the log line; the
 * logger redacts `fields`/`contextFields` by key, and a value baked into a message string has no
 * key left to redact. Echoing the value meant a signup form with a password-strength rule wrote
 * every mistyped password to the central log index in cleartext (30-day retention) and into the
 * user's own network tab — same for a card number, an SSN, or an API key pasted in the wrong box.
 *
 * So: length and type, which is what a min/max/type violation actually needs, and nothing else.
 * There is no dev-only escape hatch on purpose — a flag is one misconfigured environment away
 * from being the same breach, and a dev overlay already holds the raw request body.
 *
 * Constants are exempt only where they carry no caller data: `undefined`, `null`, `NaN` and the
 * infinities name themselves because "received a number" for a `NaN` reads as a lie.
 */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      // Code units, not code points: the length checks in `validators.ts` use `.length` too, so a
      // message quoting a different count than the rule that rejected it would send an agent
      // chasing an off-by-one that is not there.
      return countOf(value.length, 'string', 'character');
    case 'number':
      return describeNumber(value);
    case 'boolean':
      return 'a boolean';
    case 'bigint':
      return 'a bigint';
    case 'symbol':
      return 'a symbol';
    case 'function':
      return 'a function';
    default:
      break;
  }
  if (Array.isArray(value)) return countOf(value.length, 'array', 'item');
  // `getTime()` rather than a value: an invalid Date is the one Date fact a caller can act on.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'an invalid Date' : 'a Date';
  return 'an object';
}

function describeNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return 'a number';
}

function countOf(size: number, noun: string, unit: string): string {
  if (size === 0) return `an empty ${noun}`;
  const article = noun === 'array' ? 'an' : 'a';
  return `${article} ${noun} of ${size} ${unit}${size === 1 ? '' : 's'}`;
}

/**
 * `expected a uuid, received a string of 3 characters` — the message an agent can act on without
 * guessing, and without the value ever leaving the process. `what` is authored by the schema, so
 * it may say anything; the second half is `describeValue` and may not.
 */
export function expected(what: string, value: unknown): string {
  return `expected ${what}, received ${describeValue(value)}`;
}
