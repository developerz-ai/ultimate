// Single responsibility: what a SQL `LIKE` pattern matches in the in-memory driver — Postgres'
// default escape handling, counted in CHARACTERS, in time bounded by pattern × value.

import { EntityError } from './errors';

/**
 * Postgres answers a `LIKE` pattern ending in the escape character with `22025 — LIKE pattern must
 * not end with escape character`, so a pattern that means nothing there means nothing here either.
 * The pattern itself is never echoed: a filter value is app data, and this cause is rendered into
 * a log line.
 */
const danglingEscape = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}: a like pattern ends with a backslash, which is the escape character — Postgres answers that pattern with 22025 (LIKE pattern must not end with escape character)`,
    fix: "double it — 'a\\\\' is the pattern that matches one literal backslash, and 'a\\%b' matches a literal %",
  });

const ONE = Symbol('_');
const MANY = Symbol('%');

/** One literal character, `_` (exactly one character) or `%` (any run, the empty one included). */
type Part = string | typeof ONE | typeof MANY;

/**
 * The pattern as its parts: `%` and `_` are the wildcards, a backslash escapes either (or itself),
 * everything else is literal. Read by CODE POINT, which is what Postgres counts — `_` over `😀` is
 * one character there and was two UTF-16 units to a regex `.` without the `u` flag.
 *
 * A run of `%` is one `%`, as Postgres reads it.
 */
const partsOf = (entityName: string, pattern: string): readonly Part[] => {
  const chars = [...pattern];
  const parts: Part[] = [];
  for (let at = 0; at < chars.length; at += 1) {
    const char = chars[at] ?? '';
    if (char === '\\') {
      const escaped = chars[at + 1];
      if (escaped === undefined) throw danglingEscape(entityName);
      parts.push(escaped);
      at += 1;
    } else if (char === '%') {
      if (parts.at(-1) !== MANY) parts.push(MANY);
    } else {
      parts.push(char === '_' ? ONE : char);
    }
  }
  return parts;
};

/**
 * `text like pattern`. NOT a compiled regex: an anchored regex with one `.*` per `%` backtracks
 * combinatorially the moment the wildcards are separated (`%a%a%a%…b`, `%_%_%_…b`) — seconds at
 * seven of them over a 70-character value, and a filter value arrives from a search box. This is
 * the two-pointer walk with ONE backtrack point (the last `%`), so the worst case is pattern
 * length × value length whatever the pattern holds.
 */
export const likeMatches = (entityName: string, pattern: string, text: string): boolean => {
  const parts = partsOf(entityName, pattern);
  const chars = [...text];
  let part = 0;
  let char = 0;
  let star = -1;
  let resume = 0;
  while (char < chars.length) {
    const current = parts[part];
    if (current === MANY) {
      star = part;
      resume = char;
      part += 1;
    } else if (current !== undefined && (current === ONE || current === chars[char])) {
      part += 1;
      char += 1;
    } else if (star !== -1) {
      // The last `%` takes one more character and the walk resumes after it.
      part = star + 1;
      resume += 1;
      char = resume;
    } else {
      return false;
    }
  }
  while (parts[part] === MANY) part += 1;
  return part === parts.length;
};
