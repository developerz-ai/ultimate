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
const VERSION_FIRST = /(?<![\w.-])v?(\d+\.\d+\.\d+)(?![\w.-])[^`\n]{0,40}?`As of\b/;

/**
 * THE DATE MAY COME FIRST, `As of 2026-10`: `PUBLISHING.md` opened with "**`As of 2026-08-20`: 31
 * workspaces publish, all 30 are on the registry at 4.0.0**" and said "`As of 2026-08-20` `git
 * describe` answers `v4.0.0`" further down, both two majors stale, and neither was a stamp to the
 * version-first grammar. The version must sit in the SAME SENTENCE — no `. ` between them — within
 * 80 characters, and be the object of a STATE verb: "at", "answers", "is", "reads". Measured: the
 * same window without the verb read 34 sentences across 20 pages, every one a dated record of a
 * past release ("(21.0.0; plan …)"), a third party ("Bun 1.3.14") or a fix ("the 1.1.0 fix") —
 * none a claim about what this tree ships now. Backticks may sit in the gap: the claim quotes the
 * command that answered it.
 */
const DATE_FIRST =
  /`As of \d{4}-\d{2}(?:-\d{2})?`(?:[^\n.]|\.(?!\s|$)){0,80}?\b(?:at|answers|is|are|reads|says)\s+[`*_]*(?<![\w.-])v?(\d+\.\d+\.\d+)(?![\w.-])/;

/** Group 1 is a version-first stamp's version, group 2 a date-first one's. */
const STAMP = new RegExp(`${VERSION_FIRST.source}|${DATE_FIRST.source}`, 'g');

/** `docs/plans/` is a dated record; `CHANGELOG.md` names every past version by design. */
export const skipStampPath = (path: string): boolean =>
  path.startsWith('docs/plans/') || path === 'CHANGELOG.md';

export interface VersionStamp {
  readonly path: string;
  readonly line: number;
  readonly version: string;
}

/**
 * The indices of the lines a stamp may live on — everything outside a fenced block. Shared by the
 * reader and the rewriter below, because "which lines count" is one question: a rewriter with its
 * own fence loop would move a version inside a shell example the reader deliberately skipped.
 */
function* proseLineIndices(lines: readonly string[]): Generator<number> {
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[index] ?? '')) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) yield index;
  }
}

/** Every stamp on one page. Pure over the text. */
export function readStamps(file: MarkdownFile): readonly VersionStamp[] {
  const found: VersionStamp[] = [];
  const lines = file.text.split('\n');
  for (const index of proseLineIndices(lines)) {
    for (const match of (lines[index] ?? '').matchAll(STAMP)) {
      found.push({ path: file.path, line: index + 1, version: (match[1] ?? match[2]) as string });
    }
  }
  return found;
}

/**
 * Every stamp on one page moved to `version` — the edit `X_VERSION_STAMP_STALE` names, performed,
 * so a release bump writes the footer rather than leaving it for the gate to refuse at the tag.
 *
 * The `STAMP` grammar itself, never a second pattern: what the rule FINDS and what a release
 * WRITES have to be the same sentence, or a bump moves a line the check does not read and leaves
 * the line it does. Only the version inside the match moves — the `` `As of `` date beside it is
 * somebody's claim about when the sentence was true, and a release does not know it.
 */
export function rewriteStamps(
  file: MarkdownFile,
  version: string,
): { readonly text: string; readonly moved: number } {
  const lines = file.text.split('\n');
  let moved = 0;
  for (const index of proseLineIndices(lines)) {
    const line = lines[index] ?? '';
    lines[index] = line.replace(
      STAMP,
      (whole: string, first: string | undefined, last: string | undefined) => {
        const found = first ?? last ?? version;
        if (found === version) return whole;
        moved += 1;
        // A version-first `whole` starts AT the version (the optional `v` is inside the match), so
        // its first occurrence is the stamp and never the date behind it. A date-first `whole`
        // ENDS at it — and a first-occurrence replace there would hit `14.0.0-rc1` before `4.0.0`.
        return first !== undefined
          ? whole.replace(found, version)
          : `${whole.slice(0, whole.length - found.length)}${version}`;
      },
    );
  }
  return { text: lines.join('\n'), moved };
}

export const readStampPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of STAMP_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipStampPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};
