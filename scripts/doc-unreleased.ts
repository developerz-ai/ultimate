#!/usr/bin/env bun
// Enforce, at a release commit or while `[Unreleased]` is empty, that no current page still says
// the work it describes is unreleased: `As of Unreleased`, "not yet tagged", a claim about what the
// next major does, or a `main` cell on `wiki/Known-Gaps.md`. Each is true the day it is written and
// false the day the release ships; `lib/unreleased-claims.ts` catches the ones naming a version,
// and these name none, so nothing re-read them — 11 Known-Gaps `main` rows and one `As of
// Unreleased` outlived their release on 2026-11-02.
//
// WHEN: between releases every phrase is allowed — it is true. The rule bites when `CHANGELOG.md`'s
// `[Unreleased]` holds nothing, or HEAD carries a `v*` tag: then everything the tree describes has
// shipped. `release.ts --bump` rewrites each Known-Gaps `main` cell to the version in the same step
// that promotes the section (`rewriteMainCells`), so only prose is left to edit by hand.
//
//   bun run scripts/doc-unreleased.ts [--json]

import { CHANGELOG_PATH, taggedVersion } from './changelog-check';
import { parseScriptArgs } from './lib/args';
import { parseChangelog, UNRELEASED } from './lib/changelog-sections';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { toPosix } from './lib/posix-path';
import { repoRoot } from './lib/run';
import { CLAIM_SURFACES } from './lib/unreleased-claims';

const SCRIPT = 'doc-unreleased';
const KNOWN_GAPS = 'wiki/Known-Gaps.md';
/** Dated records: true of the tree they describe, which is not this one. */
const NOT_CURRENT = /^(?:docs\/plans\/|docs\/history\/|CHANGELOG\.md$)/;
const FENCE = /^\s*(?:```|~~~)/;
const MAIN_CELL = /\|\s*`main`\s*(?=\|)/g;

/**
 * Each phrase, and what it is called in a finding. "Next major" only with the verb that makes it a
 * claim about THIS repository's coming release: `x upgrade`'s pages say "the next major" about an
 * app's pin, and that stays true after every release.
 */
const PHRASES: readonly { readonly name: (match: string) => string; readonly re: RegExp }[] = [
  { name: () => 'As of Unreleased', re: /\bAs of Unreleased\b/gi },
  { name: () => 'not yet tagged', re: /\bnot yet tagged\b/gi },
  {
    name: (match) => match.toLowerCase(),
    re: /\bnext major (?:closes|ships|lands|fixes|removes|flips|makes|changes|will)\b|\b(?:lands?|ships?|flips?|fixed|arrives?|closes?) in the next major\b/gi,
  },
];

export interface UnreleasedPhrase {
  readonly path: string;
  readonly line: number;
  readonly phrase: string;
}

/** Every phrase on one page, outside fences. Pure over the text. */
export function unreleasedPhrases(path: string, text: string): readonly UnreleasedPhrase[] {
  const found: UnreleasedPhrase[] = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const { name, re } of PHRASES) {
      for (const match of line.matchAll(re)) {
        found.push({ path, line: index + 1, phrase: name(match[0]) });
      }
    }
    if (path === KNOWN_GAPS && MAIN_CELL.test(line)) {
      found.push({ path, line: index + 1, phrase: '`main` cell' });
    }
    MAIN_CELL.lastIndex = 0;
  });
  return found;
}

/** Whether everything the tree describes has shipped: a tagged HEAD, or an empty `[Unreleased]`. */
export function atRelease(changelog: string, tagged: string | undefined): boolean {
  if (tagged !== undefined) return true;
  const pending = parseChangelog(changelog).find((section) => section.version === UNRELEASED);
  return pending === undefined || !pending.filled;
}

export interface UnreleasedInput {
  readonly changelog: string;
  readonly tagged?: string | undefined;
  readonly pages: readonly { readonly path: string; readonly text: string }[];
}

/** Pure: nothing between releases; at one, a finding per phrase. */
export function checkUnreleasedPhrases(input: UnreleasedInput): readonly Finding[] {
  if (!atRelease(input.changelog, input.tagged)) return [];
  return input.pages
    .flatMap((page) => unreleasedPhrases(page.path, page.text))
    .map((hit) => {
      const at = `${hit.path}:${String(hit.line)}`;
      return {
        code: 'X_DOC_UNRELEASED_STALE',
        cause: `${at} says "${hit.phrase}", and ${CHANGELOG_PATH}'s [Unreleased] is empty or HEAD is tagged — what it calls unreleased has shipped`,
        fix: `bun run scripts/doc-unreleased.ts --json   # then edit ${at} to name the version from CHANGELOG.md; a Known-Gaps \`main\` cell is what bun run scripts/release.ts --bump rewrites at release`,
        at,
      };
    });
}

/**
 * The release-time edit: each Known-Gaps `` `main` `` cell becomes `**<version>**`, the Closed
 * table's own spelling for a release. A cell, never prose: "fixed on `main`" explains the column.
 */
export function rewriteMainCells(
  text: string,
  version: string,
): { readonly text: string; readonly moved: number } {
  let moved = 0;
  const rewritten = text.replace(MAIN_CELL, () => {
    moved += 1;
    return `| **${version}** `;
  });
  return { text: rewritten, moved };
}

/** Every current page, `/`-spelt and sorted. */
async function currentPages(root: string): Promise<UnreleasedInput['pages']> {
  const paths = new Set<string>();
  for (const pattern of CLAIM_SURFACES) {
    for (const scanned of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      const path = toPosix(scanned);
      if (!NOT_CURRENT.test(path) && !path.includes('node_modules/')) paths.add(path);
    }
  }
  const pages: { path: string; text: string }[] = [];
  for (const path of [...paths].sort()) {
    pages.push({ path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return pages;
}

export async function docUnreleasedFindings(root: string): Promise<readonly Finding[]> {
  const log = Bun.file(`${root}/${CHANGELOG_PATH}`);
  if (!(await log.exists())) {
    return [
      {
        code: 'X_CORPUS_UNSCANNED',
        cause: `${CHANGELOG_PATH} is missing, so ${SCRIPT} cannot tell whether the tree is at a release`,
        fix: `bun run scripts/doc-unreleased.ts --json   # run it from the repository root, where ${CHANGELOG_PATH} is`,
        at: CHANGELOG_PATH,
      },
    ];
  }
  return checkUnreleasedPhrases({
    changelog: await log.text(),
    tagged: await taggedVersion(root),
    pages: await currentPages(root),
  });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await docUnreleasedFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'no current page calls shipped work unreleased'
          : `${String(findings.length)} line(s) call shipped work unreleased`,
      findings,
    },
    args.json,
  );
}
