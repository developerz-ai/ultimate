// Single responsibility: decide whether every construct in a regex source means the SAME thing to
// `RegExp.prototype.test` and to Postgres' `~`. Nothing here escapes, emits or refuses — it names
// the first construct that does not, and `expr.ts` turns that into the refusal.
//
// WHY it has to exist: `matches(/…/)` puts ONE string in front of two engines, and JavaScript's
// RegExp and Postgres' ARE are not the same language. `\b` is a word boundary in one and a
// BACKSPACE character in the other; both compile, neither errors, and the CHECK enforces a rule the
// app never wrote. Refusing the construct is the only outcome that keeps "one declaration, two
// enforcement points" true.

/** The first construct in a pattern the two engines disagree about. */
export interface UnportablePattern {
  /** As it appears in the source: `\b`, `.`, `[:`, `a-é`. */
  readonly construct: string;
  /** Offset of `construct` in the source, so the refusal can point at it. */
  readonly at: number;
  /** One sentence naming BOTH readings — never "unsupported". */
  readonly why: string;
  /** A spelling that means the same thing in both, when one exists. */
  readonly instead: string | undefined;
}

/** A cursor past the construct just read, or the refusal that ends the scan. */
type Step = number | UnportablePattern;

const isRefusal = (step: Step): step is UnportablePattern => typeof step !== 'number';

const refuse = (
  construct: string,
  at: number,
  why: string,
  instead: string | undefined,
): UnportablePattern => ({ construct, at, why, instead });

/**
 * `\` + one of these is the same character class or control character in both engines. `\d` earns
 * its place by measurement, not by reading: POSIX fixes `[[:digit:]]` at the ten ASCII digits in
 * every locale, and `'٣' ~ '^\d$'` and `'５' ~ '^\d$'` are both false on a UTF-8 server, exactly as
 * `/^\d$/` is. `\w` and `\s` are the two that look like they belong here and do not.
 */
const PORTABLE_ESCAPES = new Set(['d', 'D', 'n', 'r', 't', 'f', 'v']);

/**
 * The escapes that compile on both sides and mean different things. Measured on PostgreSQL 18.4,
 * UTF8, `en_US.utf8` — the pairs are in `pg-invariant-pattern.live.test.ts`, which re-runs them
 * against whatever server is configured so a future Postgres cannot quietly change one.
 *
 * A `Map` and not a frozen record: the key is data read from a pattern, and `TABLE[key]` on an
 * object literal answers an `Object.prototype` member for `constructor` and `toString`.
 */
const DIVERGENT_ESCAPES = new Map<string, readonly [why: string, instead: string | undefined]>([
  ['b', ['is a word boundary in JavaScript and a BACKSPACE character in Postgres', undefined]],
  ['B', ['is a non-word-boundary in JavaScript and a literal backslash in Postgres', undefined]],
  [
    'w',
    [
      "is [A-Za-z0-9_] in JavaScript and the LOCALE's alphanumeric class in Postgres, which matches é",
      '[A-Za-z0-9_]',
    ],
  ],
  [
    'W',
    [
      "is [^A-Za-z0-9_] in JavaScript and the complement of the LOCALE's alphanumeric class in Postgres",
      '[^A-Za-z0-9_]',
    ],
  ],
  [
    's',
    [
      'matches U+00A0 and the Unicode separators in JavaScript, which Postgres’ [[:space:]] does not',
      '[ \\t\\n\\r\\f\\v]',
    ],
  ],
  ['S', ['is the complement of a class the two engines do not agree on', '[^ \\t\\n\\r\\f\\v]']],
  ['A', ['anchors the start of the string in Postgres and is the letter A in JavaScript', '^']],
  ['Z', ['anchors the end of the string in Postgres and is the letter Z in JavaScript', '$']],
  ['y', ['is a word boundary in Postgres and the letter y in JavaScript', undefined]],
  ['Y', ['is a non-word-boundary in Postgres and the letter Y in JavaScript', undefined]],
  ['m', ['anchors a word start in Postgres and is the letter m in JavaScript', undefined]],
  ['M', ['anchors a word end in Postgres and is the letter M in JavaScript', undefined]],
  ['a', ['is BEL in Postgres and the letter a in JavaScript', undefined]],
  ['e', ['is ESC in Postgres and the letter e in JavaScript', undefined]],
  ['x', ['reads up to three hex digits in Postgres and exactly two in JavaScript', undefined]],
  ['U', ['is an 8-digit codepoint in Postgres and the letter U in JavaScript', undefined]],
  ['c', ['is a control escape the two engines delimit differently', undefined]],
  ['k', ['names a group Postgres cannot declare', undefined]],
  ['p', ['is a Unicode property in JavaScript and an error in Postgres', undefined]],
  ['P', ['is a negated Unicode property in JavaScript and an error in Postgres', undefined]],
  ['0', ['is NUL in JavaScript and no Postgres text can hold one', undefined]],
]);

const BACKREFERENCE = [
  'is a backreference, and the two engines number their groups differently once a lookaround is',
  'involved',
].join(' ');

/**
 * The group openings that survive both engines. `(?:` `(?=` `(?!` `(?<=` `(?<!` are measured to
 * agree — each has a row in `pg-invariant-pattern.live.test.ts`'s agreement table, the two
 * LOOKBEHINDS only since 2026-08-25: this sentence shipped naming five and the table ran three, so
 * it was broader than the evidence for as long as it existed. The whole rest of the `(?` family is
 * refused, because ARE has no named groups at all — `(?<year>…)` is a server-side `invalid regular
 * expression` — and its inline directors (`(?i)`) are not JavaScript syntax.
 *
 * Greediness needs no rule: `~` and `.test()` both answer whether a match EXISTS, and with
 * backreferences refused no amount of greedy-vs-lazy backtracking can change that answer. So
 * `a+?b` stays in.
 */
const GROUP_OPENINGS = ['(?:', '(?=', '(?!', '(?<=', '(?<!'] as const;

/** `{n}` `{n,}` `{n,m}`, the three forms both engines read the same way. */
const QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

/**
 * `\uwxyz` is EXACTLY four hex digits in ARE and exactly four in JavaScript without the `u` flag —
 * measured to agree, including inside a bracket expression. It is in the subset for a reason that
 * is not convenience: **Bun returns a regex LITERAL's non-ASCII characters escaped**,
 * `/^é$/.source` is `^\u00E9$`, so refusing the escape would refuse every pattern an i18n rule
 * writes. Anything shorter is `invalid escape` on the server and the letter `u` in JavaScript.
 */
const HEX4 = /^[0-9A-Fa-f]{4}/;

const isAscii = (char: string): boolean => (char.codePointAt(0) ?? 0) < 0x80;

const NUL = refuse(
  '\\0',
  0,
  'is a null byte, which no Postgres text value can hold — the statement never reaches the server',
  undefined,
);

function escapeAt(source: string, at: number): Step {
  const next = source[at + 1];
  if (next === undefined) {
    return refuse('\\', at, 'ends the pattern, so there is nothing for it to escape', undefined);
  }
  const divergent = DIVERGENT_ESCAPES.get(next);
  if (divergent !== undefined) return refuse(`\\${next}`, at, divergent[0], divergent[1]);
  if (next === 'u') {
    return HEX4.test(source.slice(at + 2))
      ? at + 6
      : refuse(
          '\\u',
          at,
          'is a codepoint escape Postgres reads as exactly four hex digits and JavaScript reads as the letter u when there are fewer',
          undefined,
        );
  }
  if (PORTABLE_ESCAPES.has(next)) return at + 2;
  if (next >= '1' && next <= '9') return refuse(`\\${next}`, at, BACKREFERENCE, undefined);
  // Postgres reads `\` + any remaining ALPHANUMERIC as a special it has not been taught here, and
  // JavaScript reads it as the letter — the `\b` shape, one letter along. `\` + punctuation is that
  // character literally in both, which is what keeps `\.` `\$` `\-` `\'` `\]` in the subset.
  if (/[0-9A-Za-z]/.test(next)) {
    return refuse(
      `\\${next}`,
      at,
      'is an escape Postgres reads as a special and JavaScript reads as the letter',
      undefined,
    );
  }
  if (!isAscii(next) || next < ' ') {
    return refuse(
      `\\${next}`,
      at,
      'escapes a character outside printable ASCII, where the two engines are not measured to agree',
      undefined,
    );
  }
  return at + 2;
}

function groupAt(source: string, at: number): Step {
  if (source[at + 1] !== '?') return at + 1;
  const opening = GROUP_OPENINGS.find((form) => source.startsWith(form, at));
  if (opening !== undefined) return at + opening.length;
  return refuse(
    source.slice(at, at + 4),
    at,
    'is a group form Postgres has no syntax for — it has no named groups and no inline flags',
    undefined,
  );
}

const LEADING_BRACKET_WHY =
  'opens a class whose first ] Postgres reads as a MEMBER and JavaScript reads as the close of an empty class';

const RANGE_WHY =
  'is a range whose endpoints Postgres orders by the database COLLATION and JavaScript orders by code point';

function bracketAt(source: string, at: number): Step {
  let cursor = source[at + 1] === '^' ? at + 2 : at + 1;
  // `[]a]` is the literal `]` plus `a` to Postgres and an EMPTY class followed by `a]` to
  // JavaScript — measured to disagree, and `\]` is the one spelling both read as a member.
  if (source[cursor] === ']') return refuse('[]', at, LEADING_BRACKET_WHY, '\\]');
  /** The last member that could be the lower end of a range; `undefined` after one is consumed. */
  let previous: string | undefined;
  while (cursor < source.length) {
    const char = source[cursor] ?? '';
    if (char === ']') return cursor + 1;
    if (char === '\u0000') return { ...NUL, at: cursor };
    if (char === '[') {
      const kind = source[cursor + 1] ?? '';
      if (kind === ':' || kind === '.' || kind === '=') {
        return refuse(
          `[${kind}`,
          cursor,
          'opens a POSIX class, collating element or equivalence class, none of which JavaScript has',
          undefined,
        );
      }
      previous = char;
      cursor += 1;
      continue;
    }
    if (char === '\\') {
      const step = escapeAt(source, cursor);
      if (isRefusal(step)) return step;
      previous = undefined;
      cursor = step;
      continue;
    }
    const upper = source[cursor + 1];
    if (char === '-' && previous !== undefined && upper !== undefined && upper !== ']') {
      if (upper === '\\') {
        const step = escapeAt(source, cursor + 1);
        if (isRefusal(step)) return step;
        if (!isAscii(previous)) return refuse(`${previous}-\\`, cursor - 1, RANGE_WHY, undefined);
        previous = undefined;
        cursor = step;
        continue;
      }
      if (!isAscii(previous) || !isAscii(upper)) {
        return refuse(`${previous}-${upper}`, cursor - 1, RANGE_WHY, undefined);
      }
      previous = undefined;
      cursor += 2;
      continue;
    }
    previous = char;
    cursor += 1;
  }
  return refuse('[', at, 'opens a bracket expression that is never closed', undefined);
}

/**
 * The first construct in `source` the two engines read differently, or `undefined` when the whole
 * pattern is in the subset they agree on.
 *
 * Only the POSTGRES direction is judged: `matches` is handed a built `RegExp`, so JavaScript has
 * already accepted the source by the time this runs.
 */
export function unportableConstruct(source: string): UnportablePattern | undefined {
  let at = 0;
  /** Whether a `{n}` here would be a quantifier at all — it needs something to repeat. */
  let repeatable = false;
  while (at < source.length) {
    const char = source[at] ?? '';
    if (char === '\u0000') return { ...NUL, at };
    let step: Step = at + 1;
    if (char === '\\') step = escapeAt(source, at);
    else if (char === '[') step = bracketAt(source, at);
    else if (char === '(') step = groupAt(source, at);
    else if (char === '{') {
      // `/^{2}$/` compiles in JavaScript under Annex B and is `invalid regular expression` on the
      // server, so the migration is the thing that fails. Refusing here moves it to the line that
      // wrote it — and a `{` with nothing before it is that same error, which is why the quantifier
      // has to be judged in position and not by its own shape.
      const quantifier = repeatable ? QUANTIFIER.exec(source.slice(at)) : null;
      step =
        quantifier === null
          ? refuse('{', at, 'opens no quantifier Postgres can read', '\\{')
          : at + quantifier[0].length;
    } else if (char === '.') {
      // `'a\nb' ~ 'a.b'` is TRUE and `/a.b/.test('a\nb')` is false: ARE's `.` matches a newline.
      step = refuse('.', at, 'matches a newline in Postgres and never in JavaScript', '[^\\n\\r]');
    }
    if (isRefusal(step)) return step;
    // `^`, `$`, `|` and an opening `(` leave nothing to repeat; everything else does, including a
    // `)` that closed a group and a `]` that closed a class.
    repeatable = char !== '^' && char !== '$' && char !== '|' && char !== '(';
    at = step;
  }
  return undefined;
}
