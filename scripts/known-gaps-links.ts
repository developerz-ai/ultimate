#!/usr/bin/env bun
// Enforce, as a gate rule, that every carried-backlog row `wiki/Known-Gaps.md` cites is a link a
// reader can follow to the record: `[B<n>](…/blob/main/<plan file>)` names a file in this tree that
// holds a `| B<n> |` row, and the same line names the row's tracking issue — every `[#N](…)` with
// the number its URL carries. The page says "the backlog row is the record"; nothing checked the
// pointer to it, and a row renumbered or a file moved left the gap pointing at nothing.
//
// OFFLINE BY DESIGN: GitHub's issue state is not read (the gate runs with the network sealed).
// Whether a row is still OPEN is not decidable offline either — `status.yml` records a status per
// sweep, never per row, and the sweep that moved a row here is `complete` by definition.
//
// ZERO-PINNED: a broken pointer is a one-line edit.
//
//   bun run scripts/known-gaps-links.ts [--json]

// why: the checker is synchronous and pure over a reader, and Bun has no synchronous file read;
// `statSync` because a URL naming a DIRECTORY must not read as a file that exists.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'known-gaps-links';
export const KNOWN_GAPS = 'wiki/Known-Gaps.md';
export const REPO_URL = 'https://github.com/developerz-ai/ultimate';

const BACKLOG_LINK = /\[B(\d+)\]\(([^)\s]+)\)/g;
const ISSUE_LINK = /\[#(\d+)\]\(([^)\s]+)\)/g;
const BARE_ISSUE = /(?<![[\w/])#(\d+)\b/g;

export interface BacklogCitation {
  readonly line: number;
  readonly row: string;
  readonly url: string;
  /** Every `[#N](url)` on the line, as written. */
  readonly issueLinks: readonly { readonly number: string; readonly url: string }[];
  /** Every issue number the line names, linked or bare. */
  readonly issues: readonly string[];
}

/** Every `[B<n>](…)` on the page, outside fences, with the issue references on its line. */
export function citationsOf(markdown: string): readonly BacklogCitation[] {
  const out: BacklogCitation[] = [];
  let fenced = false;
  markdown.split('\n').forEach((text, index) => {
    if (/^\s*(?:```|~~~)/.test(text)) fenced = !fenced;
    if (fenced) return;
    const issueLinks = [...text.matchAll(ISSUE_LINK)].map((match) => ({
      number: match[1] ?? '',
      url: match[2] ?? '',
    }));
    const bare = [...text.replace(ISSUE_LINK, '').matchAll(BARE_ISSUE)].map((m) => m[1] ?? '');
    const issues = [...new Set([...issueLinks.map((link) => link.number), ...bare])];
    for (const match of text.matchAll(BACKLOG_LINK)) {
      out.push({
        line: index + 1,
        row: `B${match[1] ?? ''}`,
        url: match[2] ?? '',
        issueLinks,
        issues,
      });
    }
  });
  return out;
}

/** The repo path a `…/blob/main/<path>` URL names, or `undefined` for any other URL. */
export const blobPath = (url: string): string | undefined => {
  const prefix = `${REPO_URL}/blob/main/`;
  if (!url.startsWith(prefix)) return undefined;
  const path = url.slice(prefix.length).replace(/[#?].*$/, '');
  return path === '' || path.split('/').includes('..') ? undefined : path;
};

/** Whether a plan file holds the row — a table row that starts with `| B<n>` (a ★ may follow). */
export const holdsRow = (markdown: string, row: string): boolean =>
  new RegExp(`^\\|\\s*${row}(?:\\s|\\|)`, 'm').test(markdown);

/** What the checker needs from the tree, injectable so the negative cases are fixtures. */
export interface Tree {
  readonly read: (path: string) => string | undefined;
}

/** Every broken pointer on the page. Pure over `markdown` and the tree reader. */
export function checkKnownGaps(markdown: string, tree: Tree): readonly Finding[] {
  const findings: Finding[] = [];
  for (const citation of citationsOf(markdown)) {
    const at = `${KNOWN_GAPS}:${citation.line}`;
    const path = blobPath(citation.url);
    const file = path === undefined ? undefined : tree.read(path);
    if (path === undefined || file === undefined) {
      findings.push({
        code: 'X_KNOWN_GAP_LINK_MALFORMED',
        cause: `${at} links ${citation.row} to ${citation.url}, which is not a ${REPO_URL}/blob/main/<path> URL naming a file in this tree`,
        fix: `bun run scripts/known-gaps-links.ts --json   # then edit ${at}: link ${citation.row} to ${REPO_URL}/blob/main/<the plan file holding its row>`,
        at,
      });
      continue;
    }
    if (!holdsRow(file, citation.row)) {
      findings.push({
        code: 'X_KNOWN_GAP_LINK_MALFORMED',
        cause: `${at} links ${citation.row} to ${path}, which holds no | ${citation.row} | row — renumbered, or moved to another plan file`,
        fix: `bun run scripts/known-gaps-links.ts --json   # then edit ${at} to link the plan file that holds the ${citation.row} row`,
        at,
      });
    }
    for (const link of citation.issueLinks) {
      if (link.url === `${REPO_URL}/issues/${link.number}`) continue;
      findings.push({
        code: 'X_KNOWN_GAP_LINK_MALFORMED',
        cause: `${at} links #${link.number} to ${link.url}, which is not that issue's URL`,
        fix: `bun run scripts/known-gaps-links.ts --json   # then edit ${at}: link #${link.number} to ${REPO_URL}/issues/${link.number}`,
        at,
      });
    }
    if (citation.issues.length === 0) {
      findings.push({
        code: 'X_KNOWN_GAP_LINK_MALFORMED',
        cause: `${at} cites ${citation.row} and names no tracking issue, so a reader cannot tell whether the gap is still open`,
        fix: `bun run scripts/known-gaps-links.ts --json   # then open an issue for ${citation.row} and add [#<n>](${REPO_URL}/issues/<n>) to ${at}`,
        at,
      });
    }
  }
  return findings;
}

const unscanned = (): Finding => ({
  code: 'X_KNOWN_GAP_UNSCANNED',
  cause: `${KNOWN_GAPS} is missing or cites no [B<n>] row, so this rule reported green over links it never read`,
  fix: `bun run scripts/known-gaps-links.ts --json — run it from the repo root, where ${KNOWN_GAPS} is`,
  at: KNOWN_GAPS,
});

/** The real tree: a file under the root, or `undefined` for anything missing or not a file. */
export const treeAt = (root: string): Tree => ({
  read: (path) => {
    const absolute = `${root}/${path}`;
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
    return readFileSync(absolute, 'utf8');
  },
});

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function knownGapLinkFindings(root: string): Promise<readonly Finding[]> {
  const handle = Bun.file(`${root}/${KNOWN_GAPS}`);
  if (!(await handle.exists())) return [unscanned()];
  const markdown = await handle.text();
  if (citationsOf(markdown).length === 0) return [unscanned()];
  return checkKnownGaps(markdown, treeAt(root));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const findings = await knownGapLinkFindings(root);
  const cited = citationsOf(await Bun.file(`${root}/${KNOWN_GAPS}`).text()).length;
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${cited} carried-backlog citation(s) in ${KNOWN_GAPS}, every one resolves to its row and names its issue`
          : `${findings.length} broken carried-backlog pointer(s) in ${KNOWN_GAPS}`,
      findings,
      data: { cited },
    },
    args.json,
  );
}
