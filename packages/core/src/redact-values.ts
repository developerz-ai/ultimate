// Single responsibility: redaction by VALUE — the app's registered `{ pattern, replace }` matchers,
// the screen each passes at registration, and the one rewrite every sink applies to a string leaf.
// Mechanism only: the framework registers no pattern. `logger-redact.ts` owns the public door
// (`redactValues`) so the redaction generation stays in one place.

import { type CodedErrorInit, UltimateError } from './errors';

/** One value matcher: every match of `pattern` (which carries `g`) becomes `replace`. */
export interface RedactValueMatcher {
  readonly pattern: RegExp;
  /** `String.prototype.replace`'s replacement: `$1`, `$&` and friends work. */
  readonly replace: string;
}

export class RedactPatternUnsafeError extends UltimateError {
  static readonly code = 'X_REDACT_PATTERN_UNSAFE';
  override readonly name = 'RedactPatternUnsafeError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: RedactPatternUnsafeError.code });
  }
}

const matchers: RedactValueMatcher[] = [];

/** An unbounded quantifier at `index`: `*`, `+` or `{n,}` / `{n,m}` with no upper bound given. */
function unboundedAt(source: string, index: number): boolean {
  const char = source[index];
  if (char === '*' || char === '+') return true;
  return char === '{' && /^\{\d+,\}/.test(source.slice(index));
}

/**
 * Whether an unboundedly-quantified group itself contains an unbounded quantifier — `(a+)+`,
 * `(\w+\s?)*`, `((ab)*c)+`: the shape that backtracks exponentially on a near-miss. A scan, not a
 * proof: overlapping alternation (`(a|a)*`) passes. It refuses the obvious, at registration, where
 * the alternative was a log line that never finishes rendering.
 */
export function hasNestedQuantifier(source: string): boolean {
  const groups: boolean[] = [];
  let inClass = false;
  let closedQuantified = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      closedQuantified = false;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
      closedQuantified = false;
    } else if (char === '(') {
      groups.push(false);
      closedQuantified = false;
    } else if (char === ')') {
      closedQuantified = groups.pop() ?? false;
      if (closedQuantified && groups.length > 0) groups[groups.length - 1] = true;
    } else if (unboundedAt(source, index)) {
      if (closedQuantified) return true;
      if (groups.length > 0) groups[groups.length - 1] = true;
    } else {
      closedQuantified = false;
    }
  }
  return false;
}

/** Why `matcher` cannot be registered, or `undefined` when it can. */
function refusal(matcher: RedactValueMatcher): string | undefined {
  const { pattern } = matcher;
  if (!pattern.flags.includes('g')) return 'has no g flag, so only its first match is replaced';
  if (pattern.flags.includes('y')) return 'is sticky (y), so it matches only at a value’s start';
  if (hasNestedQuantifier(pattern.source)) {
    return 'nests an unbounded quantifier inside another, which backtracks exponentially';
  }
  if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test('')) {
    return 'matches the empty string, so its replacement lands between every character';
  }
  return undefined;
}

function fixFor(pattern: RegExp): string {
  const flags = pattern.flags.replace('y', '');
  const withG = flags.includes('g') ? flags : `${flags}g`;
  return `in the redactValues([...]) call, use /${pattern.source}/${withG} with no group that is quantified and holds a quantifier (write (?:a+)+ as a+), and require at least one character`;
}

/** Screen every matcher, then add them all — one refusal registers none of the list. */
export function addValueMatchers(list: readonly RedactValueMatcher[]): void {
  for (const matcher of list) {
    const why = refusal(matcher);
    if (why === undefined) continue;
    throw new RedactPatternUnsafeError({
      cause: `the redaction pattern /${matcher.pattern.source}/${matcher.pattern.flags} ${why}`,
      fix: fixFor(matcher.pattern),
      meta: { pattern: matcher.pattern.source, flags: matcher.pattern.flags },
    });
  }
  matchers.push(...list);
}

/** `text` with every registered match replaced. No matcher registered: `text`, at one compare. */
export function redactedValue(text: string): string {
  if (matchers.length === 0) return text;
  let out = text;
  for (const { pattern, replace } of matchers) out = out.replace(pattern, replace);
  return out;
}

/** Every string leaf of an already JSON-safe value (an error's `toJSON()`), rewritten. */
export function redactedStrings(value: unknown, depth = 0): unknown {
  if (matchers.length === 0) return value;
  if (typeof value === 'string') return redactedValue(value);
  if (value === null || typeof value !== 'object' || depth >= 8) return value;
  if (Array.isArray(value)) return value.map((item) => redactedStrings(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = redactedStrings(entry, depth + 1);
  return out;
}
