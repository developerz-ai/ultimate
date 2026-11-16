#!/usr/bin/env bun
// Refuse the quadratic trailing-slash regex — `/\/+$/` and its trivial spellings — in shipped
// source and scripts: `trimTrailingSlashes` from `@ultimat3/core` is the one way to trim a slash run.
//
// `/\/+$/` retries the run from every slash in it, so `'a' + '/'.repeat(100_000) + 'a'` costs 8.5 s
// on Bun (measured 2026-11-16; 50k: 2.0 s — quadratic), and a base URL, an issuer or an origin is
// often caller input (CodeQL `js/polynomial-redos`). Sweep 8b-2 replaced it at 26 sites and nothing
// stopped the 27th — axiom 3 says a rule that is not a build error does not exist.
//
//   bun run scripts/trailing-slash-regex.ts [--json]

import { singleLine } from '../packages/core/src/error-render';
import { maskLiterals, stripComments } from '../packages/core/src/source-mask';
import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'trailing-slash-regex';

/** The one implementation, as a script imports it — never the `@ultimat3/core` barrel. */
export const HELPER_MODULE = 'packages/core/src/trailing-slashes.ts';

export interface TrailingSlashSource {
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  readonly text: string;
}

/**
 * A slash run anchored at the END only — `\/+`, `\/*`, `[/]+`, `[\/]+`, `\/{1,}`, then `$` — read
 * off the comment-stripped text, where a regex body still holds its characters. Which of these are
 * a REGEX (and not a string quoting one) is decided against the masked view, below.
 */
const TAIL_RUN = /(?:\\\/|\[\\?\/\])(?:\+|\*|\{1,\})\$/g;

/**
 * The scan is the slow one only when an attempt may START anywhere: the run opens the regex body or
 * an alternative (`/^\/+|\/+$/`). `/^\/+$/` asks whether a string is all slashes and `/x\/+$/`
 * pins its start to an `x`: both linear, and neither a trim.
 */
const OPENS_ALTERNATIVE: ReadonlySet<string> = new Set(['/', '|']);
/** And it ENDS one: the body closes, or the next alternative or group does. */
const CLOSES_ALTERNATIVE: ReadonlySet<string> = new Set(['/', '|', ')']);

/**
 * Whether `at` sits inside a regex literal. `maskLiterals` blanks a regex body and a string's
 * contents alike but keeps their delimiters, so the first kept character to the left is the opener:
 * a `/` is a regex, a quote is a string quoting one — prose about the shape, never the shape.
 */
const inRegex = (masked: string, at: number): boolean => {
  if (masked[at] !== ' ') return false;
  let i = at - 1;
  while (i >= 0 && masked[i] === ' ') i -= 1;
  return masked[i] === '/';
};

const finding = (path: string, line: number): Finding => {
  const place = singleLine(`${path}:${String(line)}`);
  return {
    code: 'X_TRAILING_SLASH_REGEX',
    cause: `${place} trims a trailing slash run with a regex that rescans the run from every slash in it — quadratic on a long run (100k slashes: 8.5 s on Bun), and the value is often caller input`,
    fix: `bun run trailing-slash-regex --json   # then in ${place} call trimTrailingSlashes(value) instead — import { trimTrailingSlashes } from '@ultimat3/core' in a package, from '../packages/core/src/trailing-slashes' (adjust the depth) in scripts/; a leading trim stays .replace(/^\\/+/, ''), which is linear`,
    at: `${path}:${String(line)}`,
  };
};

/** Every quadratic trailing-slash regex in `files`, one finding per site. Pure. */
export function checkTrailingSlashRegexes(
  files: readonly TrailingSlashSource[],
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    // Every shape this reads holds `$`: a file without one is never masked.
    if (!file.text.includes('$')) continue;
    const stripped = stripComments(file.text);
    const masked = maskLiterals(file.text);
    for (const match of stripped.matchAll(TAIL_RUN)) {
      const at = match.index;
      const before = stripped[at - 1] ?? '';
      const after = stripped[at + match[0].length] ?? '';
      if (!OPENS_ALTERNATIVE.has(before) || !CLOSES_ALTERNATIVE.has(after)) continue;
      if (!inRegex(masked, at)) continue;
      findings.push(finding(file.path, lineOf(file.text, at)));
    }
  }
  return findings;
}

/** Shipped source and scripts: the corpus `source` scope without its test files. */
const readSources = async (root: string): Promise<readonly TrailingSlashSource[]> =>
  (await corpus(root, 'source'))
    .filter((file) => !isTestPath(file.path))
    .map((file) => ({ path: file.path, text: file.source }));

export const trailingSlashRegexFindings = async (root: string): Promise<readonly Finding[]> =>
  checkTrailingSlashRegexes(await readSources(root));

/** What the command prints, as a value: `findings`, so `--json` carries every one. */
export const trailingSlashRegexResult = (files: readonly TrailingSlashSource[]): ScriptResult => {
  const findings = checkTrailingSlashRegexes(files);
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${String(files.length)} files, every trailing slash run trimmed by ${HELPER_MODULE}`
        : `${String(findings.length)} quadratic trailing-slash regex(es)`,
    findings,
    data: { scanned: files.length },
  };
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(trailingSlashRegexResult(await readSources(repoRoot())), args.json);
}
