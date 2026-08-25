// Every case here is a MEASURED disagreement between `RegExp.prototype.test` and Postgres' `~`,
// or a measured agreement. The measurements are re-run against a real server by
// `pg-invariant-pattern.live.test.ts`; this file pins the classifier that acts on them.

import { describe, expect, test } from 'bun:test';
import { unportableConstruct } from './pattern-portability';

/** The construct the scanner names, or `'portable'` — one string per case keeps the tables flat. */
const verdict = (source: string): string => unportableConstruct(source)?.construct ?? 'portable';

describe('a construct the two engines read differently is named', () => {
  // `pg=true js=false` on 'a\nb' and on 'a\rb', measured on PostgreSQL 18.4: ARE's `.` matches a
  // newline and JavaScript's does not. An anchored `^a.b$` is not a defence — the divergence is in
  // the atom, not in the anchoring.
  test('. is refused, because ARE matches a newline with it and JavaScript does not', () => {
    expect(verdict('^a.b$')).toBe('.');
    expect(unportableConstruct('^a.b$')?.instead).toBe('[^\\n\\r]');
  });

  // The flagship: `'foo' ~ '\bfoo'` is FALSE on the server and `/\bfoo/.test('foo')` is true,
  // because ARE reads `\b` as the BACKSPACE character. It compiles on both sides and means two
  // different things — no error anywhere, which is what makes it the worst case in the table.
  test('\\b is refused, and it is the case that compiles cleanly on both sides', () => {
    // The `why` and not only the verdict: an unlisted escape is refused too, generically, and a
    // refusal that says "Postgres reads this as a special" instead of "Postgres reads this as a
    // BACKSPACE" leaves the author guessing at the one thing they need to know.
    expect(unportableConstruct('\\bfoo')).toMatchObject({
      construct: '\\b',
      why: expect.stringContaining('BACKSPACE'),
      // No portable spelling exists: ARE's word boundary is `\y`, which JavaScript reads as `y`.
      instead: undefined,
    });
  });

  test('an escape neither table names is refused, where Postgres would fail the migration', () => {
    // `'q' ~ '^\q$'` is `invalid regular expression: invalid escape \q` on the server and `true`
    // in JavaScript. Refused at declaration, it is a line number instead of a failed ROLE=migrate.
    expect(verdict('^\\q$')).toBe('\\q');
    expect(verdict('^\\g$')).toBe('\\g');
  });

  test('\\w and \\s are refused with the ASCII class that replaces them', () => {
    // `'é' ~ '^\w$'` is TRUE on the server (the locale's alnum class) and false in JavaScript.
    expect(unportableConstruct('^\\w+$')).toMatchObject({
      construct: '\\w',
      instead: '[A-Za-z0-9_]',
    });
    // `' ' ~ '^\s$'` is FALSE on the server and true in JavaScript.
    expect(unportableConstruct('^\\s$')).toMatchObject({
      construct: '\\s',
      instead: '[ \\t\\n\\r\\f\\v]',
    });
  });

  test('a POSIX class is refused — [[:alpha:]] matches nothing a JavaScript RegExp means', () => {
    expect(verdict('^[[:alpha:]]+$')).toBe('[:');
  });

  test('a leading ] is refused: ARE reads it as a member, JavaScript closes an empty class', () => {
    expect(unportableConstruct('^[]a]$')).toMatchObject({ construct: '[]', instead: '\\]' });
  });

  test('\\x is refused, because the two engines read a different number of hex digits', () => {
    // `'\x414'` is U+0414 to Postgres and `A` then `4` to JavaScript — measured. The reason is
    // asserted, not just the verdict: without its own row `\x` still lands on the generic escape
    // refusal, which says nothing about digit counts.
    expect(unportableConstruct('^\\x414$')).toMatchObject({
      construct: '\\x',
      why: expect.stringContaining('hex digits'),
    });
  });

  test('the ARE-only anchors and control escapes are refused', () => {
    for (const [source, construct] of [
      ['\\a', '\\a'],
      ['\\e', '\\e'],
      ['\\B', '\\B'],
      ['a\\yb', '\\y'],
    ] as const) {
      expect(verdict(source)).toBe(construct);
    }
    // `'a' ~ '^\Aa$'` is TRUE and `/^\Aa$/.test('a')` is false: an anchor to one engine and a
    // letter to the other. The portable spelling is the anchor the author meant.
    expect(unportableConstruct('\\Aa')).toMatchObject({ construct: '\\A', instead: '^' });
    expect(unportableConstruct('a\\Z')).toMatchObject({ construct: '\\Z', instead: '$' });
  });

  test('a backreference and an octal escape are refused', () => {
    expect(verdict('^(a)\\1$')).toBe('\\1');
    expect(verdict('^\\0$')).toBe('\\0');
  });

  test('a named group is refused; Postgres has no such syntax and errors on it', () => {
    expect(verdict('^(?<year>\\d{4})$')).toBe('(?<y');
  });

  test('a { that opens no quantifier is refused, with the escape that makes it a literal', () => {
    // `'{2}' ~ '^{2}$'` is a server-side `invalid regular expression`; the JavaScript literal
    // `/^{2}$/` compiles under Annex B. A refusal at declaration beats a migration that will not
    // apply.
    expect(unportableConstruct('^{2}$')).toMatchObject({ construct: '{', instead: '\\{' });
    expect(verdict('^a{2,3}$')).toBe('portable');
    expect(verdict('^a{2,}$')).toBe('portable');
  });

  test('a range endpoint outside ASCII is refused — ARE orders it by the collation', () => {
    expect(verdict('^[a-é]$')).toBe('a-é');
    // A non-ASCII MEMBER is a value, not an ordering, and stays portable.
    expect(verdict('^[éa]$')).toBe('portable');
  });

  test('a NUL is refused: Postgres text cannot hold one, so the statement never parses', () => {
    expect(verdict('a\u0000b')).toBe('\\0');
  });

  test('a \\u escape keeps its four digits, because Bun escapes a literal é into one', () => {
    // `/^é$/.source` is `^\u00E9$` under Bun — the ENGINE escapes it, not the author — so refusing
    // the escape would refuse every non-ASCII pattern written as a literal. Measured to agree at
    // exactly four digits, and `invalid escape` on the server at fewer.
    // The constructor and the literal produce DIFFERENT sources for one pattern, which is the fact
    // under test: biome's "safe" fix rewrites the first into the second and erases it.
    // biome-ignore lint/complexity/useRegexLiterals: asserting the difference between the two forms
    expect(new RegExp('^é$').source).toBe('^é$');
    expect(/^é$/.source).toBe('^\\u00E9$');
    expect(verdict('^\\u00E9$')).toBe('portable');
    expect(verdict('^[\\u00E9a]$')).toBe('portable');
    expect(verdict('^\\u41$')).toBe('\\u');
    // `\U` stays out: eight digits in Postgres, the letter U in JavaScript.
    expect(verdict('^\\U0001F600$')).toBe('\\U');
  });

  test('the index it names is the offset of the construct in the source', () => {
    expect(unportableConstruct('^ab\\bcd$')?.at).toBe(3);
    expect(unportableConstruct('^ab.cd$')?.at).toBe(3);
  });
});

describe('what the subset keeps — every one of these is measured to agree', () => {
  const portable = [
    '^[a-z0-9]+(-[a-z0-9]+)*$',
    '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    '^\\d{4}-\\d{2}-\\d{2}$',
    '^[A-Z]{3}$',
    '^(?=[^\\n\\r]*[0-9])[a-z0-9]+$',
    '^(?!x)[a-z]+$',
    '(?<=a)b',
    '^a+?b$',
    '^[-a]$',
    '^[a-]$',
    '^[\\]]$',
    '^\\]$',
    '^}$',
    '^]$',
    '^\\.$',
    '^\\$$',
    '^\\-$',
    "^'$",
    '^--$',
    '^\\n\\r\\t\\f\\v$',
    '^é$',
    '^[^é]$',
    '^\\D$',
  ] as const;

  for (const source of portable) {
    test(`${source} is portable`, () => {
      expect(verdict(source)).toBe('portable');
    });
  }
});
