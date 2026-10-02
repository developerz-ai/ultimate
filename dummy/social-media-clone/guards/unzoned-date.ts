// unzoned-date: a date is stored in UTC and formatted with an explicit IANA zone, never with the
// host's ambient one. `x verify` discovers every file in `guards/` and runs its `guard` inside
// the `boundaries` step — nothing registers this file, so nothing can forget to.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_UNZONED_DATE';

/** Every call whose output depends on a zone. The `(` is the start of the argument list. */
const FORMATTER = /(?:\.toLocale(?:Date|Time)?String|Intl\.DateTimeFormat)\s*\(/g;

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/**
 * Comments blanked IN PLACE — not deleted — so the line number a finding reports still points at
 * the source line. What it does not blank is a string body: a call spelled inside a quoted string
 * is reported, which is the one false positive this rule can produce and the reason its own test
 * lives in `guards/`, which nothing here scans.
 */
const blank = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length));

/**
 * The call's own argument list, from its `(` to the `)` that closes it. Depth-counted rather
 * than "up to the next `)`": `toLocaleDateString(locale, { timeZone: zoneFor(x) })` closes twice
 * before the one that ends the call, and reading only the first would report a zoned call.
 */
function argumentsOf(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function unzonedDates(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const match of text.matchAll(FORMATTER)) {
      const open = match.index + match[0].length - 1;
      if (argumentsOf(text, open).includes('timeZone')) continue;
      const line = lineOf(text, match.index);
      // The bare `.toLocaleString(` is ALSO `Number.prototype.toLocaleString`, and a regex cannot
      // tell a count from a date. The match stands — a date formatted this way is the defect this
      // guard exists for — but the fix names the number exit too, because `{ timeZone }` is not
      // one: a number ignores it, and an author following the fix verbatim would ship a lie.
      const bare = match[0].trim() === '.toLocaleString(';
      findings.push({
        code: CODE,
        cause: `${file.path}:${line} calls ${match[0].trim()}) with no timeZone — it formats in whatever zone the process happens to run in, so one row reads as two different days across two containers`,
        fix: bare
          ? `in ${file.path}: a Date → pass an explicit IANA zone, at.toLocaleString(locale, { timeZone: 'UTC' }); a NUMBER → new Intl.NumberFormat(locale).format(n) instead — then: x verify`
          : `pass an explicit IANA zone in ${file.path} — toLocaleDateString(locale, { timeZone: 'UTC' }) — then: x verify`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a date is never formatted without an explicit IANA time zone',
  async check(_root, sources) {
    // A test's subject is often the wrong shape on purpose; excluding it hides no rendered date
    // from a user. The run's ONE read of the source: every guard asking for this glob shares it.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return unzonedDates(
      code
        .filter((file) => !/\.(?:test|d)\.tsx?$/.test(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
