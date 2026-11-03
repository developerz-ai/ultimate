#!/usr/bin/env bun
// Enforce, as a gate rule, that every Open row of `wiki/Known-Gaps.md` links a test asserting
// today's behaviour — `[pin](…/blob/main/<file>.test.ts#<test name>)` — so closing the gap fails the
// pin, and the failing pin sends its author back to the row. A row nothing ties to the code goes
// stale silently: on 2026-11-02, 15 of 25 rows checked were false.
//
// THE PIN: a `…/blob/main/` URL (`known-gaps-links.ts`' form) naming a `*.test.ts` or `*.test.tsx`
// in this tree, whose fragment, URL-decoded, is the title of a `test(` or `it(` in that file. A row
// that cannot be tested — one unreproduced sighting — writes `pin: none` and why, in the row.
// `## Open by decision` rows need none: they are not going to close.
//
// RATCHET: rows unpinned when this rule landed are listed by their first cell in
// `scripts/lib/known-gaps-unpinned-pins.ts`. The list only falls: a new row is pinned when it is
// written, and a listed row pinned (or closed) since is a stale entry to delete.
//
//   bun run scripts/known-gaps-pins.ts [--json]

import { blobPath, KNOWN_GAPS, treeAt } from './known-gaps-links';
import { parseScriptArgs } from './lib/args';
import { KNOWN_GAPS_UNPINNED, UNPINNED_FILE } from './lib/known-gaps-unpinned-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'known-gaps-pins';
const RERUN = 'bun run scripts/known-gaps-pins.ts --json';
const PIN_LINK = /\[pin\]\(([^)\s]+)\)/g;
// The reason is the point of the escape hatch: a bare `pin: none` is a row that opted out unexplained.
const PIN_NONE = /\bpin: none\b\W{0,3}\s*([^|]{10,})/;
const TEST_FILE = /\.test\.tsx?$/;

/** What the rule needs from the tree, injectable so the negative cases are fixtures. */
export interface PinTree {
  readonly read: (path: string) => string | undefined;
}

export interface OpenRow {
  readonly line: number;
  /** The first cell, as written: the row's name, and its key on the baseline. */
  readonly key: string;
  readonly text: string;
}

/** The table rows of `## Open` alone — not `## Open by decision`, which is a different heading. */
export function openRows(markdown: string): readonly OpenRow[] {
  const rows: OpenRow[] = [];
  let inOpen = false;
  markdown.split('\n').forEach((text, index) => {
    if (text.startsWith('## ')) inOpen = text.trim() === '## Open';
    if (!inOpen || !text.startsWith('| ')) return;
    const key = (text.split(/(?<!\\)\|/)[1] ?? '').trim();
    if (key === 'Gap' || /^-+$/.test(key)) return;
    rows.push({ line: index + 1, key, text });
  });
  return rows;
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `source` declares a test with exactly this title: the first argument of `test(`/`it(`. */
export const testTitled = (source: string, title: string): boolean =>
  new RegExp(
    String.raw`\b(?:test|it)(?:\.\w+(?:\([^)]*\))?)*\(\s*(['"\`])${literal(title)}\1`,
  ).test(source);

/** Why one pin link does not hold, or `undefined` when it names a real test. */
function deadPin(url: string, tree: PinTree): string | undefined {
  const path = blobPath(url);
  if (path === undefined || !TEST_FILE.test(path)) {
    return `links ${url}, which is not a blob/main URL naming a *.test.ts file`;
  }
  const source = tree.read(path);
  if (source === undefined) return `pins ${path}, which this tree does not have`;
  const hash = url.indexOf('#');
  let title = hash === -1 ? '' : url.slice(hash + 1);
  try {
    title = decodeURIComponent(title);
  } catch {
    // A malformed escape is checked as written: it names no test, which is the finding.
  }
  if (title === '') return `pins ${path} and names no test after the #`;
  return testTitled(source, title)
    ? undefined
    : `pins "${title}", which ${path} has no test titled`;
}

const at = (row: OpenRow): string => `${KNOWN_GAPS}:${String(row.line)}`;

/** Every row with no live pin and no baseline entry, and every baseline entry that is stale. */
export function checkKnownGapPins(
  markdown: string,
  tree: PinTree,
  baseline: readonly string[],
): readonly Finding[] {
  const rows = openRows(markdown);
  if (rows.length === 0) {
    return [
      {
        code: 'X_CORPUS_UNSCANNED',
        cause: `${KNOWN_GAPS} has no "## Open" table rows, so ${SCRIPT} reported green over rows it never read`,
        fix: `${RERUN}   # run it from the repository root, where ${KNOWN_GAPS} is, and keep the "## Open" heading`,
        at: KNOWN_GAPS,
      },
    ];
  }
  const allowed = new Set(baseline);
  const findings: Finding[] = [];
  for (const row of rows) {
    const links = [...row.text.matchAll(PIN_LINK)].map((match) => match[1] ?? '');
    const dead = links.map((url) => deadPin(url, tree)).filter((why) => why !== undefined);
    const pinned = (links.length > 0 && dead.length === 0) || PIN_NONE.test(row.text);
    if (pinned && allowed.has(row.key)) {
      findings.push({
        code: 'X_KNOWN_GAP_PIN_STALE',
        cause: `${at(row)} is pinned now, and ${UNPINNED_FILE} still lets it go unpinned — the entry would admit a new unpinned row under the same name`,
        fix: `${RERUN}   # then delete the "${row.key}" entry from KNOWN_GAPS_UNPINNED in ${UNPINNED_FILE}`,
        at: at(row),
      });
    }
    if (pinned || (allowed.has(row.key) && dead.length === 0)) continue;
    findings.push({
      code: 'X_KNOWN_GAP_UNPINNED',
      cause: `${at(row)} "${row.key}" ${dead[0] ?? 'links no test asserting today’s behaviour'}, so closing the gap would leave this row standing`,
      fix: `${RERUN}   # then add [pin](https://github.com/developerz-ai/ultimate/blob/main/<the test file>#<the test title>) to ${at(row)}, or state "pin: none" and why`,
      at: at(row),
    });
  }
  const keys = new Set(rows.map((row) => row.key));
  for (const key of baseline.filter((one) => !keys.has(one))) {
    findings.push({
      code: 'X_KNOWN_GAP_PIN_STALE',
      cause: `${UNPINNED_FILE} lists "${key}", which is no Open row of ${KNOWN_GAPS} — closed or renamed`,
      fix: `${RERUN}   # then delete the "${key}" entry from KNOWN_GAPS_UNPINNED in ${UNPINNED_FILE}, or rename it to the row's first cell as written`,
      at: UNPINNED_FILE,
    });
  }
  return findings;
}

/** What the committed tree answers. */
export async function knownGapPinFindings(root: string): Promise<readonly Finding[]> {
  const page = Bun.file(`${root}/${KNOWN_GAPS}`);
  const markdown = (await page.exists()) ? await page.text() : '';
  return checkKnownGapPins(markdown, treeAt(root), KNOWN_GAPS_UNPINNED);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const findings = await knownGapPinFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `every Open row of ${KNOWN_GAPS} is pinned, or on the falling baseline (${String(KNOWN_GAPS_UNPINNED.length)})`
          : `${String(findings.length)} Open row(s) or baseline entries out of step`,
      findings,
      data: { baseline: KNOWN_GAPS_UNPINNED.length },
    },
    args.json,
  );
}
