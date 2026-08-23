// The stamp GRAMMAR, and the pages it is read from. Split out of `scripts/version-stamps.ts` when
// that file crossed the 500-line ceiling: what a stamp LOOKS LIKE and what a manifest SAYS are two
// subjects, and only the first of them is a text rule over markdown.
//
// The rule the grammar serves lives next door — one stamp, on `wiki/_Footer.md`, naming the version
// every workspace declares. This file answers only "where does this page claim a version".

import type { MarkdownFile } from './doc-citations';
import { readMarkdown } from './doc-citations';

/** The one page allowed to name a version, and the one page required to. */
export const STAMP_PAGE = 'wiki/_Footer.md';

export const STAMP_GLOBS: readonly string[] = [
  '*.md',
  'wiki/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
];

/**
 * A STAMP is a version followed, on the same line, by an `` `As of `` date — never a bare `X.Y.Z`.
 *
 * The `` `As of `` anchor is what separates a claim about this build from an example of one, and
 * both live in the tree today: `PUBLISHING.md` writes `git tag v1.1.0` in a shell block and
 * `v1.10.1` in a worked example of the tag-versus-manifest mismatch, and
 * `docs/idea/17-scale-ladder.md` names Yugabyte's `v2025.2.3`. None of the three is a claim about
 * `@ultimat3/*` and a rule that read them as one would be a rule its readers learn to ignore.
 *
 * THE `v` IS OPTIONAL AND THE GAP IS WIDE, `As of 2026-08-23`, because the old pattern —
 * `\bv(\d+\.\d+\.\d+)[\s*_.]*`As of\b` — required the letter and allowed only whitespace, `*`, `_`
 * and `.` before the backtick, and so saw ZERO stamps in the two most-read files in the repo:
 * `AGENTS.md` says `**3.0.0** in lockstep, \`As of 2026-08-19\`` and root `CLAUDE.md` said
 * `**Status:** 7.0.0, released, \`As of 2026-08-21\``, both while the tree shipped a later major.
 * The rule printed `✓ 30 workspaces at 9.0.0, and wiki/_Footer.md is the one page that says so`
 * over a two-major lie. One missing character defeated it.
 *
 * The gap is CAPPED at 40 characters and may hold no backtick and no newline, which is what keeps
 * "`v1.1.0` … some other sentence … `As of`" from joining two unrelated claims into one match. The
 * price of the widening is the handful of sentences that name a PAST or a THIRD-PARTY version
 * within reach of a date; those are pinned, one page and version at a time, in
 * `scripts/lib/version-stamp-pins.ts`, never excused by narrowing this back.
 */
const STAMP = /(?<![\w.-])v?(\d+\.\d+\.\d+)(?![\w.-])[^`\n]{0,40}?`As of\b/g;

/** `docs/plans/` is a dated record; `CHANGELOG.md` names every past version by design. */
export const skipStampPath = (path: string): boolean =>
  path.startsWith('docs/plans/') || path === 'CHANGELOG.md';

export interface VersionStamp {
  readonly path: string;
  readonly line: number;
  readonly version: string;
}

/** Every stamp on one page. Pure over the text. */
export function readStamps(file: MarkdownFile): readonly VersionStamp[] {
  const found: VersionStamp[] = [];
  const lines = file.text.split('\n');
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(STAMP)) {
      found.push({ path: file.path, line: index + 1, version: match[1] as string });
    }
  }
  return found;
}

export const readStampPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of STAMP_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipStampPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};
