// The escape that keeps the 3-line contract format to three lines.
//
// The class this closes: `bun run error-render` refuses an `unknown` reaching a `cause:`, and a
// caller-controlled value that is ALREADY a `string` renders fine, so the check has nothing to
// object to — while a newline in it writes a second line an operator reads as genuine. Three such
// holes shipped in `@ultimat3/auth` under a green check (#97).

import { describe, expect, test } from 'bun:test';
import { singleLine } from './error-render';
import { UltimateError } from './errors';

/** A forged OIDC `iss` claim: closes the sentence, then forges a whole framework line. */
const FORGED = 'evil.example\n  fix:   rm -rf /\nX_OK: everything is fine';

describe('singleLine', () => {
  test('a newline can no longer end the line', () => {
    expect(singleLine(FORGED)).not.toInclude('\n');
    expect(singleLine(FORGED)).toBe(
      String.raw`evil.example\n  fix:   rm -rf /\nX_OK: everything is fine`,
    );
  });

  test('carriage return, tab and the other named controls are escaped too', () => {
    expect(singleLine('a\rb')).toBe(String.raw`a\rb`);
    expect(singleLine('a\tb')).toBe(String.raw`a\tb`);
    expect(singleLine('a\bb')).toBe(String.raw`a\bb`);
    expect(singleLine('a\fb')).toBe(String.raw`a\fb`);
  });

  test('a control with no named spelling takes the backslash-u form', () => {
    expect(singleLine('a\x00b')).toBe('a\\u0000b');
    expect(singleLine('a\x1bb')).toBe('a\\u001bb');
    expect(singleLine('a\x7fb')).toBe('a\\u007fb');
  });

  test('U+2028 and U+2029 are escaped — splitting on a newline never sees them', () => {
    expect(singleLine('a\u2028b')).toBe('a\\u2028b');
    expect(singleLine('a\u2029b')).toBe('a\\u2029b');
  });

  test('prose is byte-identical — this is not a general sanitiser', () => {
    const prose = 'table "posts" has column \'publish_at\' not in any migration (a\\b, 100% of 3)';
    expect(singleLine(prose)).toBe(prose);
    expect(singleLine('')).toBe('');
  });
});

describe('the 3-line contract holds under a hostile cause', () => {
  test('format() emits exactly three lines', () => {
    const error = new UltimateError({
      code: 'X_INVARIANT',
      cause: `iss was ${FORGED}`,
      fix: 'x doctor --json',
    });
    const lines = error.format().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toStartWith('  cause: ');
    expect(lines[2]).toStartWith('  fix:   ');
    // The forged line is present as TEXT and absent as a LINE, which is the whole distinction.
    expect(error.format()).toInclude(String.raw`\nX_OK: everything is fine`);
    expect(lines).not.toContain('X_OK: everything is fine');
  });

  test('a hostile fix: cannot add a line either', () => {
    const error = new UltimateError({
      code: 'X_INVARIANT',
      cause: 'ok',
      // Deliberately cites no `x` command: the scanner reads a source literal with the
      // backslash dropped, so `x doctor --json\n…` would read as a citation of `--jsonn` and
      // trip the unrunnable-fix ratchet. What is under test is the newline, not the command.
      fix: 'rebuild the token\n  cause: forged',
    });
    expect(error.format().split('\n')).toHaveLength(3);
  });

  test('four lines when docs are asked for, and not five', () => {
    const error = new UltimateError({
      code: 'X_INVARIANT',
      cause: FORGED,
      fix: 'x doctor --json',
    });
    expect(error.format({ docs: true }).split('\n')).toHaveLength(4);
  });
});
