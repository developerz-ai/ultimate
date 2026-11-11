// error-declared: an app code is declared once, with defineError — its title, its status and its class.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
// defineError is imported from @ultimat3/core/page: an errors module is shared by actions and
// islands, and the barrel carries the framework's titles tables into every island that throws.
//
// Known limits, both read by nothing short of a type checker: an alias by assignment
// (const Base = UltimateError) and a shorthand key whose value is a literal elsewhere
// (const code = 'X_NOT_FOUND'; new UltimateError({ code, … })).

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_ERROR_DECLARED';

/** Every import of core — the barrel or its page subpath: a named list (an alias) or a namespace. */
const NAMED_IMPORT =
  /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@ultimat3\/core(?:\/page)?['"]/g;
const NAMESPACE_IMPORT =
  /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]@ultimat3\/core(?:\/page)?['"]/g;
const ALIAS = /^\s*UltimateError\s+as\s+([A-Za-z_$][\w$]*)\s*$/;

/** The barrel alone — never its page subpath — and defineError in a named list, aliased or not. */
const BARREL_NAMED = /\bimport\s+\{([^}]*)\}\s*from\s*['"]@ultimat3\/core['"]/g;
const BARREL_NAMESPACE =
  /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]@ultimat3\/core['"]/g;
const DEFINE_ERROR = /^\s*defineError(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/;

/** A literal code as the object's own key — bare or quoted — read where the walk below stands. */
const LITERAL_CODE = /^(?:code|'code'|"code")\s*:\s*['"`]/;

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** Comments blanked IN PLACE — not deleted — so a reported line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The names UltimateError goes by in this file: its own, an alias, or a namespace's member. */
const classNames = (text: string): readonly string[] => {
  const names = ['UltimateError'];
  for (const match of text.matchAll(NAMED_IMPORT)) {
    for (const part of (match[1] ?? '').split(',')) {
      const alias = ALIAS.exec(part)?.[1];
      if (alias !== undefined) names.push(alias);
    }
  }
  for (const match of text.matchAll(NAMESPACE_IMPORT)) {
    if (match[1] !== undefined) names.push(`${match[1]}.UltimateError`);
  }
  return names;
};

/** One alternation over those names, a namespace's dot allowed its whitespace. */
const nameSource = (names: readonly string[]): string =>
  names.map((name) => name.replaceAll('$', '\\$').replaceAll('.', '\\s*\\.\\s*')).join('|');

/** Past the string or template opening at open. */
const pastQuoted = (text: string, open: number): number => {
  let index = open + 1;
  while (index < text.length && text[index] !== text[open]) {
    index += text[index] === '\\' ? 2 : 1;
  }
  return index + 1;
};

/**
 * Whether the object literal opening at open carries a literal code as its OWN key, or spreads one
 * in from a nested literal. A key deeper down — meta: { code: 'X_TIMEOUT' } — is a value, not
 * the error's code.
 */
const literalCodeIn = (text: string, open: number): boolean => {
  let depth = 0;
  let index = open + 1;
  while (index < text.length) {
    const char = text[index] ?? '';
    // Read before a quote is skipped: a quoted key ('code': …) starts with one.
    if (depth === 0) {
      const rest = text.slice(index);
      if (LITERAL_CODE.test(rest) && !/[\w$.]/.test(text[index - 1] ?? '')) return true;
      const spread = /^\.\.\.\s*\{/.exec(rest);
      if (spread !== null && literalCodeIn(text, index + spread[0].length - 1)) return true;
    }
    if (char === "'" || char === '"' || char === '`') {
      index = pastQuoted(text, index);
      continue;
    }
    if ('{[('.includes(char)) depth += 1;
    if ('}])'.includes(char)) depth -= 1;
    if (depth < 0) return false;
    index += 1;
  }
  return false;
};

const finding = (file: SourceFile, line: number, what: string): Finding => ({
  code: CODE,
  cause: `${file.path}:${line} ${what} — the title, the HTTP status and the class are then declared apart, and a code with no status answers 500 and hides its cause`,
  fix: `rewrite it in ${file.path} as defineError({ code, title, status, cause, fix }) from @ultimat3/core/page (offSocket: true for a code no response carries), then: x verify`,
  at: file.path,
});

const barrelFinding = (file: SourceFile, line: number): Finding => ({
  code: CODE,
  cause: `${file.path}:${line} takes defineError from the @ultimat3/core barrel — every island that throws the code then carries the framework's titles table, ~5.5 kB it never reads`,
  fix: `import { defineError } from '@ultimat3/core/page' in ${file.path} — the same function, without the table — then: x verify`,
  at: file.path,
});

/** Each line that reaches defineError through the barrel: a named import, or a namespace's member. */
const barrelDefineErrorLines = (text: string): readonly number[] => {
  const lines: number[] = [];
  for (const match of text.matchAll(BARREL_NAMED)) {
    if ((match[1] ?? '').split(',').some((part) => DEFINE_ERROR.test(part))) {
      lines.push(lineOf(text, match.index));
    }
  }
  for (const match of text.matchAll(BARREL_NAMESPACE)) {
    const member = nameSource([`${match[1] ?? ''}.defineError`]);
    for (const use of text.matchAll(new RegExp(`\\b${member}\\b`, 'g'))) {
      lines.push(lineOf(text, use.index));
    }
  }
  return lines;
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function undeclaredErrors(files: readonly SourceFile[]): readonly Finding[] {
  const found: { readonly path: string; readonly line: number; readonly finding: Finding }[] = [];
  for (const file of files) {
    const text = blank(file.source);
    const names = nameSource(classNames(text));
    const push = (index: number, what: string): void => {
      const line = lineOf(text, index);
      found.push({ path: file.path, line, finding: finding(file, line, what) });
    };
    for (const line of barrelDefineErrorLines(text)) {
      found.push({ path: file.path, line, finding: barrelFinding(file, line) });
    }
    for (const match of text.matchAll(new RegExp(`\\bextends\\s+(?:${names})\\b`, 'g'))) {
      push(match.index, 'subclasses UltimateError by hand');
    }
    for (const match of text.matchAll(new RegExp(`\\bnew\\s+(?:${names})\\s*\\(\\s*`, 'g'))) {
      const at = match.index + match[0].length;
      // Anything but an object literal hides its code from this read: a value built elsewhere,
      // Object.assign over a literal. A re-raise is written as a literal, with code: err.code.
      if (text[at] !== '{')
        push(match.index, 'builds new UltimateError from a value this guard cannot read');
      else if (literalCodeIn(text, at))
        push(match.index, 'builds new UltimateError with a literal code');
    }
  }
  return found
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
    .map((entry) => entry.finding);
}

export const guard: Guard = {
  summary:
    'an app error code is declared with defineError — never a handwritten UltimateError subclass',
  async check(_root, sources) {
    // A test may build any error it likes as INPUT. The run's ONE read of the source: every guard
    // asking for this glob shares the walk.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return undeclaredErrors(
      code
        .filter((file) => !/\.(?:test|d)\.tsx?$/.test(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
