#!/usr/bin/env bun
// Enforce that every shipped source file opens with a 1–4 line header stating its one responsibility.
//
// Root `CLAUDE.md` makes the header a contract, but prose is not enforcement: a file without one
// says nothing about what it owns, and a long first paragraph buries the responsibility.
//
//   bun run source-headers  ·  bun run scripts/source-headers.ts [--json]

import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { SOURCE_HEADER_PINS, SOURCE_HEADER_PINS_FILE } from './lib/source-header-pins';

const SCRIPT = 'source-headers';

export type SourceHeaderProblem = 'missing' | 'empty' | 'too-long';

/** One file's leading header, read from the source itself. */
export interface SourceHeader {
  readonly path: string;
  readonly lines: readonly string[];
  readonly problem?: SourceHeaderProblem;
}

/**
 * The leading header: a line-comment block or a block-comment block, after an optional shebang.
 *
 * The first PARAGRAPH is what the contract judges. Later paragraphs are the why, and a block
 * header's delimiters are never prose.
 */
export function readSourceHeader(path: string, source: string): SourceHeader {
  const lines = source.split(/\r?\n/);
  let at = 0;
  while (at < lines.length && (lines[at]?.startsWith('#!') || lines[at]?.trim() === '')) at += 1;
  const first = lines[at]?.trimStart() ?? '';
  if (first.startsWith('/*')) {
    const end = lines.findIndex((line, index) => index >= at && line.includes('*/'));
    const body = lines.slice(at + 1, end === -1 ? lines.length : end);
    const paragraph: string[] = [];
    for (const line of body) {
      const text = line.replace(/^\s*\*\s?/, '').trim();
      if (text === '') break;
      paragraph.push(text);
    }
    if (paragraph.length === 0) return { path, lines: [], problem: 'empty' };
    return paragraph.length > 4
      ? { path, lines: paragraph, problem: 'too-long' }
      : { path, lines: paragraph };
  }
  const paragraph: string[] = [];
  while (at < lines.length) {
    const line = lines[at];
    if (line === undefined || !line.startsWith('//')) break;
    const text = line.replace(/^\/\/\s?/, '').trim();
    if (text === '') break;
    paragraph.push(text);
    at += 1;
  }
  if (paragraph.length === 0) return { path, lines: [], problem: 'missing' };
  return paragraph.length > 4
    ? { path, lines: paragraph, problem: 'too-long' }
    : { path, lines: paragraph };
}

/** Whether the header's first paragraph carries prose rather than punctuation alone. */
export const hasSourceHeaderProse = (header: SourceHeader): boolean =>
  header.lines.some((line) => /[A-Za-z0-9]/.test(line));

/**
 * The finding for a file that opens with no header comment at all.
 *
 * One object per code, each writing its code as a literal at the `code:` key: the gate's code
 * scanner reads `code: 'X_…'` and nothing else, so a code hidden in a ternary is a code no
 * registry, no manifest and no reference page ever hears of.
 */
const missingFinding = (header: SourceHeader): Finding => ({
  code: 'X_SOURCE_HEADER_MISSING',
  cause: `${header.path} opens with no header comment, so it states no single responsibility`,
  fix: `bun run scripts/source-headers.ts --json   # then add a 1–4 line header comment to ${header.path} stating its single responsibility`,
  at: header.path,
});

/** The finding for a header that is there but says nothing: an empty one, or one without prose. */
const emptyFinding = (header: SourceHeader): Finding => ({
  code: 'X_SOURCE_HEADER_OUT_OF_CONTRACT',
  cause: `${header.path} opens with an empty header comment, so it states no single responsibility`,
  fix: `bun run scripts/source-headers.ts --json   # then add a 1–4 line header comment to ${header.path} stating its single responsibility`,
  at: header.path,
});

/** The finding for a first paragraph longer than the four lines the contract allows. */
const tooLongFinding = (header: SourceHeader): Finding => ({
  code: 'X_SOURCE_HEADER_OUT_OF_CONTRACT',
  cause: `${header.path} opens with a ${String(header.lines.length)}-line first paragraph, outside the 1–4 line responsibility contract`,
  fix: `bun run scripts/source-headers.ts --json   # then rewrite the leading header of ${header.path} as 1–4 lines of prose stating its single responsibility`,
  at: header.path,
});

const overFinding = (header: SourceHeader): Finding => {
  if (header.problem === 'missing') return missingFinding(header);
  if (header.problem === 'empty') return emptyFinding(header);
  return tooLongFinding(header);
};

const staleFinding = (path: string, pinned: number, found: number): Finding => ({
  code: 'X_SOURCE_HEADER_PIN_STALE',
  cause: `${path} is pinned at ${String(pinned)} header violation(s) and now has ${String(found)} — the pin is above what this tree contains, so it would let ${String(pinned - found)} back in`,
  fix: `bun run scripts/source-headers.ts --json   # then lower the count for '${path}' in ${SOURCE_HEADER_PINS_FILE}`,
  at: SOURCE_HEADER_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_SOURCE_HEADER_UNSCANNED',
  cause:
    'no shipped source file was read, so every file reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree of perfect headers',
  fix: 'bun run scripts/source-headers.ts   # then edit PATTERNS in scripts/lib/corpus.ts so it matches this repo layout',
  at: 'scripts/lib/corpus.ts',
});

/** Every finding this rule contributes, read off the shared corpus and the per-file pin table. */
export async function sourceHeaderFindings(root: string): Promise<readonly Finding[]> {
  const files = await corpus(root, 'shipped');
  if (files.length === 0) return [unscannedFinding()];
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  for (const file of files) {
    const header = readSourceHeader(file.path, file.source);
    const problem =
      header.problem ?? (hasSourceHeaderProse(header) ? undefined : ('empty' as const));
    if (problem === undefined) continue;
    const found = (counts.get(file.path) ?? 0) + 1;
    counts.set(file.path, found);
    const pinned = SOURCE_HEADER_PINS[file.path];
    if (pinned !== undefined && found <= pinned.count) continue;
    findings.push(overFinding({ ...header, problem }));
  }
  for (const [path, pin] of Object.entries(SOURCE_HEADER_PINS)) {
    // A pin describes THIS repository: a fixture root does not hold the pinned files, and their
    // absence there is not a stale row.
    if (!(await Bun.file(`${root}/${path}`).exists())) continue;
    const found = counts.get(path) ?? 0;
    if (found < pin.count) findings.push(staleFinding(path, pin.count, found));
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await sourceHeaderFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'every shipped source file opens with a 1–4 line responsibility header'
          : `${String(findings.length)} source header finding(s)`,
      findings,
    },
    args.json,
  );
}
