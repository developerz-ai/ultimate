// bare-error: a failure this app raises carries a code, a cause and an executable fix.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_BARE_ERROR';

/**
 * A THROW, never a construction. `new Error(…)` handed to something as INPUT is legitimate — a
 * test fixture, an `AbortSignal` reason, a rejection this module is passing along — and only the
 * throw is this module stating its own verdict.
 */
const BARE_THROW = /\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError)\s*\(/g;

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

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function bareThrows(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const match of text.matchAll(BARE_THROW)) {
      const line = lineOf(text, match.index);
      const thrown = match[1] ?? 'Error';
      findings.push({
        code: CODE,
        cause: `${file.path}:${line} throws a bare ${thrown} — it reaches its reader as a stack trace with no code, no cause and nothing to run`,
        fix: `subclass UltimateError in ${file.path} with an X_SCREAMING_SNAKE code, a cause and a fix naming a command, then: x verify`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a failure carries a code, a cause and an executable fix — never a bare Error',
  async check(root) {
    const files: SourceFile[] = [];
    for await (const entry of new Bun.Glob('{apps,packages}/**/*.{ts,tsx}').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\').join('/');
      // A test states its verdict with `expect.unreachable()`, which the suite reports on its own
      // terms; `node_modules` is not this app's source.
      if (path.includes('node_modules/') || /\.(?:test|d)\.tsx?$/.test(path)) continue;
      files.push({ path, source: await Bun.file(`${root}/${path}`).text() });
    }
    return bareThrows(files);
  },
};
