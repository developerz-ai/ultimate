// What a `jsonb` column refuses of text `JSON.stringify` accepts. Asked of the text, by whoever is
// about to store it, so a memory store and Postgres answer alike and the refusal lands before a
// statement does: only production meets `jsonb`, after the work behind the value has already run.

/** One escape at a time, so the second backslash of `\\u0000` is never read as opening a third. */
const ESCAPE = /\\(?:u(?:0000|d[89a-f][0-9a-f]{2})|[\s\S])/g;

/**
 * Why `jsonb` would refuse this `JSON.stringify` output, or `undefined` when it would not. A pair
 * of surrogates is written raw by `JSON.stringify`, so an escaped surrogate in its output is always
 * a lone one. The reason names the class of thing, never the text, which can carry anything.
 */
export function jsonbRefusal(text: string): string | undefined {
  // Nearly every value holds no `\u` at all: the scan is paid only by one that does.
  if (!text.includes('\\u')) return undefined;
  for (const [token] of text.matchAll(ESCAPE)) {
    if (token === '\\u0000') return 'a NUL character in a string, which jsonb has no form for';
    if (token.startsWith('\\ud')) return 'a lone surrogate in a string, which jsonb refuses';
  }
  return undefined;
}
