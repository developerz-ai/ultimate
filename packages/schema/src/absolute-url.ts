// Single responsibility: the one rule deciding whether a string is an absolute URL `t.url` may
// return as written — parseable, and not a string the parser had to cut before it could read it.

/**
 * What the URL parser DISCARDS before it reads anything: leading and trailing C0 controls and
 * spaces, and every tab or newline wherever it sits (WHATWG URL §4.4, the two "validation error"
 * strips). `URL.canParse` reports none of it, and this validator returns the string it was given —
 * so `' https://a.b'` validated, was stored untrimmed, and rendered into an `href` as a relative
 * path. The parsed `href` is only stable for input the parser did not have to cut.
 *
 * Deliberately NOT `new URL(value).href === value`: that refuses `https://example.com` (the href
 * gains a `/`) and any upper-case host, which are the same URL written differently, not a
 * different string than the one validated.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are the rule.
const URL_PARSER_STRIPS = /^[\u0000-\u0020]|[\u0000-\u0020]$|[\t\n\r]/;

export function isAbsoluteUrl(value: string): boolean {
  return !URL_PARSER_STRIPS.test(value) && URL.canParse(value);
}
