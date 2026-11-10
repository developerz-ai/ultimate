// The log reader on its own: every wrapper a GitHub Actions log puts around a finding, undone, so
// the `cause:`/`fix:` that comes back is the text the gate wrote — never the transport around it.

import { describe, expect, test } from 'bun:test';
import { findingsFrom, parseLogLines } from './ci-log';

const STAMP = '2026-11-09T10:00:00.1234567Z';

/** One Actions log line: job, step, timestamp, text — the shape `gh run view --log-failed` prints. */
const row = (text: string, job = 'verify', step = 'Run x verify'): string =>
  `${job}\t${step}\t${STAMP} ${text}`;

const read = (lines: readonly string[]) => findingsFrom(parseLogLines(lines.join('\n')));

describe('unit · ci-log reads a finding out of every wrapper the log puts on it', () => {
  // The adopter's report, byte for byte: `x ci`'s own human render of a fenced fix, run inside a
  // CI job, prints the fence's newlines as the two characters `\n`. Read back, that line has to
  // be the command and nothing else.
  test('a fenced fix printed on one line comes back as the bare command', () => {
    const found = read([
      row('X_LINT_FAILED'),
      row('  cause: biome found 3 errors'),
      row(
        String.raw`  fix:   <comment id="ci-log verify">\nbunx biome check --write .\n</comment>`,
      ),
    ]);
    expect(found).toEqual([
      { code: 'X_LINT_FAILED', cause: 'biome found 3 errors', fix: 'bunx biome check --write .' },
    ]);
  });

  test('a fence spread over real lines is unwrapped too', () => {
    const found = read([
      row('X_LINT_FAILED'),
      row('  cause: biome found 3 errors'),
      row('  fix:   <comment id="ci-log verify">'),
      row('bunx biome check --write .'),
      row('</comment>'),
    ]);
    expect(found.map((finding) => finding.fix)).toEqual(['bunx biome check --write .']);
  });

  test('a cause that is fenced is unwrapped the same way', () => {
    const found = read([
      row('X_LINT_FAILED'),
      row(String.raw`  cause: <comment id="ci-log verify">\nbiome found 3 errors\n</comment>`),
      row('  fix:   bunx biome check --write .'),
    ]);
    expect(found.map((finding) => finding.cause)).toEqual(['biome found 3 errors']);
  });

  test('a finding inside ##[group] … ##[endgroup] is read, and the markers are not text', () => {
    const lines = parseLogLines(
      [
        row('##[group]Run bun run x -- verify'),
        row('X_LINT_FAILED'),
        row('  cause: biome found 3 errors'),
        row('  fix:   bunx biome check --write .'),
        row('##[endgroup]'),
      ].join('\n'),
    );
    expect(lines.map((line) => line.text)).toEqual([
      'Run bun run x -- verify',
      'X_LINT_FAILED',
      '  cause: biome found 3 errors',
      '  fix:   bunx biome check --write .',
    ]);
    expect(findingsFrom(lines).map((finding) => finding.code)).toEqual(['X_LINT_FAILED']);
  });

  // How the runner prints an annotation in the downloaded log: the level as a `##[…]` prefix.
  test('##[error] / ##[warning] / ##[notice] prefixes are taken off each line', () => {
    const found = read([
      row('##[error]X_LINT_FAILED'),
      row('##[error]  cause: biome found 3 errors'),
      row('##[error]  fix:   bunx biome check --write .'),
    ]);
    expect(found).toEqual([
      { code: 'X_LINT_FAILED', cause: 'biome found 3 errors', fix: 'bunx biome check --write .' },
    ]);
    const levels = parseLogLines(
      [row('##[warning]careful'), row('##[notice]fyi'), row('##[debug]noise')].join('\n'),
    );
    expect(levels.map((line) => line.text)).toEqual(['careful', 'fyi', 'noise']);
  });

  // The workflow command itself, as a step that echoes it leaves it in the log: properties, `::`,
  // then a message whose newlines GitHub's encoding turned into `%0A`.
  test('an ::error workflow command is decoded into the lines it encodes', () => {
    const found = read([
      row(
        '::error file=src/a.ts,line=3,title=verify::X_LINT_FAILED%0A  cause: 100%25 of 3 files%0A  fix:   bunx biome check --write .',
      ),
    ]);
    expect(found).toEqual([
      {
        code: 'X_LINT_FAILED',
        cause: '100% of 3 files',
        fix: 'bunx biome check --write .',
      },
    ]);
  });

  // Message data escapes only `%`, CR and LF; `%3A`/`%2C` are PROPERTY escapes, so in a message
  // they are the bytes the step wrote — a URL in a fix must come back exactly as printed.
  test('an annotation message decodes %0A, %0D and %25 only, %25 last', () => {
    const found = read([
      row(
        "::error::X_A%0A  cause: 50%25 of it%0D%0A  fix:   curl 'https://example.com/a%2Cb%3Ac' # %250A stays",
      ),
    ]);
    expect(found).toEqual([
      {
        code: 'X_A',
        cause: '50% of it',
        fix: "curl 'https://example.com/a%2Cb%3Ac' # %0A stays",
      },
    ]);
  });

  test('a plain fix is carried through untouched', () => {
    const found = read([
      row('X_A'),
      row('  cause: c'),
      row('  fix:   x verify --only lint   # <comment> is just text here'),
    ]);
    expect(found.map((finding) => finding.fix)).toEqual([
      'x verify --only lint   # <comment> is just text here',
    ]);
  });
});
