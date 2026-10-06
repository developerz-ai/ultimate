// The Known-Gaps pointer rule: a `[B<n>]` link names a plan file in this tree that holds the row,
// and its line names a well-formed tracking issue. Fixtures for every broken shape, then the page.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Tree } from './known-gaps-links';
import {
  blobPath,
  checkKnownGaps,
  citationsOf,
  KNOWN_GAPS,
  knownGapLinkFindings,
  REPO_URL,
} from './known-gaps-links';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree: the repo-scan budget, as every scripts test that does.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const PLAN = 'docs/plans/p/10-carried-backlog.md';
const tree: Tree = {
  read: (path) =>
    path === PLAN ? '| Row | What |\n|---|---|\n| B24 | a gap |\n| B7 ★ | b |\n' : undefined,
};
const row = (cite: string, issue: string): string => `| ${cite} | a gap | work around | ${issue} |`;
const link = (n: number, path = PLAN): string => `[B${n}](${REPO_URL}/blob/main/${path})`;
const issue = (n: number, url = `${REPO_URL}/issues/${n}`): string => `[#${n}](${url})`;

describe('the Known-Gaps pointer rule', () => {
  test('a row that links its plan row and its issue holds', () => {
    expect(checkKnownGaps(row(link(24), issue(685)), tree)).toEqual([]);
    // A ★ beside the row number is still that row; a bare `#691` in prose is still an issue.
    expect(checkKnownGaps(`${link(7)}, #691.`, tree)).toEqual([]);
  });

  test.each([
    ['a URL that is not a blob of this repo', row('[B24](https://example.com/x.md)', issue(1))],
    ['a plan file that does not exist', row(link(24, 'docs/plans/gone.md'), issue(1))],
    ['a file that holds no such row', row(link(25), issue(1))],
    [
      'an issue link whose URL names another issue',
      row(link(24), issue(685, `${REPO_URL}/issues/686`)),
    ],
    ['no issue at all', row(link(24), 'none yet')],
  ])('%s is X_KNOWN_GAP_LINK_MALFORMED, at its line', (_name, markdown) => {
    const findings = checkKnownGaps(`intro\n${markdown}`, tree);
    expect(findings.map((finding) => finding.code)).toEqual(['X_KNOWN_GAP_LINK_MALFORMED']);
    expect(findings[0]?.at).toBe(`${KNOWN_GAPS}:2`);
  });

  test('a citation inside a fence is not read, and a traversal is not a blob path', () => {
    expect(citationsOf(`\`\`\`\n${row(link(99), '')}\n\`\`\``)).toEqual([]);
    expect(blobPath(`${REPO_URL}/blob/main/../etc/passwd`)).toBeUndefined();
    expect(blobPath(`${REPO_URL}/blob/main/${PLAN}#b24`)).toBe(PLAN);
  });
});

describe('against this repo', () => {
  test('every carried-backlog citation in the wiki resolves, over a non-vacuous read', async () => {
    const root = repoRoot();
    const markdown = await Bun.file(`${root}/${KNOWN_GAPS}`).text();
    expect(citationsOf(markdown).length).toBeGreaterThan(0);
    expect(await knownGapLinkFindings(root)).toEqual([]);
  });
});
