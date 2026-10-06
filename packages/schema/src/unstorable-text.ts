// Single responsibility: the ONE predicate naming a string Postgres cannot store as written — the
// rule every string-backed validator (`t.string` and its kin, a `t.record` key, `t.json()`) shares,
// so the three can never disagree about which input reaches the row write.

const NUL = '\u0000';
/** A lone UTF-16 surrogate. `String#isWellFormed` is ES2024 and the lib is ES2023. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why a string cannot be stored, or `undefined`. Both MEASURED against Postgres 17: a NUL is
 * refused by `text` and `jsonb` alike (22021 / 22P05), a lone surrogate by `jsonb` (22P02) — and
 * into `text`, Bun's sql encodes it as U+FFFD, so the row holds a different string than the
 * caller sent while a memory store holds the original. Passing either moved the failure to the
 * row write, as a 500 with no field path. Names the fact, never the content (`describe-value.ts`).
 */
export function unstorable(text: string): string | undefined {
  if (text.includes(NUL)) return 'that contains a NUL character (U+0000)';
  if (LONE_SURROGATE.test(text)) return 'that contains a lone UTF-16 surrogate';
  return undefined;
}
