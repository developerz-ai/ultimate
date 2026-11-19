// Single responsibility: the text Postgres parses as a `uuid`, and the one spelling it prints —
// so an operand no `uuid` column can hold is known before a statement carries it, and a spelling
// the server would have matched is the same value to both drivers.

/**
 * `uuid_in`'s grammar: thirty-two hex digits, a hyphen allowed after any group of four but the
 * last, the whole optionally in braces. No blanks — the server refuses a padded value.
 */
const UUID_TEXT = /^(?:[0-9a-f]{4}-?){7}[0-9a-f]{4}$/i;

/**
 * The lower-cased `8-4-4-4-12` spelling of `value`, or `undefined` when it is not a `uuid`'s text.
 * Bound as a parameter the latter is `22P02`, a 500 for an id straight out of a URL.
 */
export const canonicalUuid = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const braced = value.startsWith('{') && value.endsWith('}');
  const text = braced ? value.slice(1, -1) : value;
  if (!UUID_TEXT.test(text)) return undefined;
  const hex = text.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
