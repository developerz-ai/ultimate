#!/usr/bin/env bun
// Enforce, as a gate rule, that `docs/architecture/02-boundaries.md`'s generated-app rule table
// describes the checker that ships: the count it states ("Six, each with its own code") and the
// codes its rows name are exactly `BOUNDARY_CODES` (`packages/cli/src/app-boundaries.ts`). The page
// once claimed rules no checker implemented; a code added or retired in the CLI moved neither.
//
//   bun run scripts/boundary-rule-docs.ts [--json]

import { BOUNDARY_CODES } from '../packages/cli/src/app-boundaries';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'boundary-rule-docs';
export const BOUNDARY_DOC = 'docs/architecture/02-boundaries.md';
const SECTION = /^## Generated-app rules\b.*$/m;

const NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** `Six` → 6, `7` → 7; `undefined` for anything else. */
export const countOf = (word: string): number | undefined => {
  if (/^\d+$/.test(word)) return Number(word);
  const index = NUMBER_WORDS.indexOf(word.toLowerCase());
  return index === -1 ? undefined : index;
};

export interface BoundaryDocFacts {
  /** 1-based line of the section heading, `undefined` when the page has no such section. */
  readonly line: number | undefined;
  /** The count the section's first sentence states, and its line. */
  readonly count: { readonly value: number; readonly line: number } | undefined;
  /** Every `X_BOUNDARY_*` code in the section table's Code column, in row order. */
  readonly codes: readonly string[];
}

/** The section's stated count and the codes its table rows name. Pure over the page. */
export function readBoundaryDoc(markdown: string): BoundaryDocFacts {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => SECTION.test(line));
  if (start === -1) return { line: undefined, count: undefined, codes: [] };
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));
  const body = lines.slice(start + 1, end === -1 ? undefined : end);
  let count: BoundaryDocFacts['count'];
  const codes: string[] = [];
  body.forEach((line, offset) => {
    const stated = /^(\w+), each with its own code\b/.exec(line)?.[1];
    const value = stated === undefined ? undefined : countOf(stated);
    if (count === undefined && value !== undefined) count = { value, line: start + 2 + offset };
    if (!line.startsWith('|')) return;
    const cell = line.split('|')[2] ?? '';
    const code = /`(X_BOUNDARY_[A-Z_]+)`/.exec(cell)?.[1];
    if (code !== undefined) codes.push(code);
  });
  return { line: start + 1, count, codes };
}

/** Every disagreement between the page and `BOUNDARY_CODES`. */
export function checkBoundaryDoc(
  facts: BoundaryDocFacts,
  shipped: readonly string[] = BOUNDARY_CODES,
): readonly Finding[] {
  if (facts.line === undefined || facts.count === undefined || facts.codes.length === 0) {
    return [
      {
        code: 'X_DOC_BOUNDARY_RULES_UNSCANNED',
        cause: `${BOUNDARY_DOC} has no "## Generated-app rules" section stating "<N>, each with its own code" above a table of codes, so this rule compared nothing`,
        fix: `bun run scripts/boundary-rule-docs.ts --json   # then restore the section in ${BOUNDARY_DOC}: "${shipped.length}, each with its own code" and one table row per code`,
        at: BOUNDARY_DOC,
      },
    ];
  }
  const findings: Finding[] = [];
  const countAt = `${BOUNDARY_DOC}:${facts.count.line}`;
  if (facts.count.value !== shipped.length) {
    findings.push({
      code: 'X_DOC_BOUNDARY_RULES_STALE',
      cause: `${countAt} says the checker has ${facts.count.value} rule(s) and BOUNDARY_CODES (packages/cli/src/app-boundaries.ts) holds ${shipped.length}`,
      fix: `bun run scripts/boundary-rule-docs.ts --json   # then edit ${countAt} to state ${NUMBER_WORDS[shipped.length] ?? shipped.length}`,
      at: countAt,
    });
  }
  const tableAt = `${BOUNDARY_DOC}:${facts.line}`;
  const missing = shipped.filter((code) => !facts.codes.includes(code));
  const extra = facts.codes.filter((code) => !shipped.includes(code));
  const repeated = facts.codes.filter((code, index) => facts.codes.indexOf(code) !== index);
  if (missing.length > 0 || extra.length > 0 || repeated.length > 0) {
    findings.push({
      code: 'X_DOC_BOUNDARY_RULES_STALE',
      cause: `the rule table under ${tableAt} does not list BOUNDARY_CODES once each — missing: ${missing.join(', ') || 'none'}; not shipped: ${extra.join(', ') || 'none'}; repeated: ${repeated.join(', ') || 'none'}`,
      fix: `bun run scripts/boundary-rule-docs.ts --json   # then edit the table under ${tableAt} to one row per BOUNDARY_CODES entry`,
      at: tableAt,
    });
  }
  return findings;
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function boundaryRuleDocFindings(root: string): Promise<readonly Finding[]> {
  const handle = Bun.file(`${root}/${BOUNDARY_DOC}`);
  const markdown = (await handle.exists()) ? await handle.text() : '';
  return checkBoundaryDoc(readBoundaryDoc(markdown));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await boundaryRuleDocFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${BOUNDARY_DOC} states ${BOUNDARY_CODES.length} rules and lists every BOUNDARY_CODES entry once`
          : `${findings.length} disagreement(s) between ${BOUNDARY_DOC} and BOUNDARY_CODES`,
      findings,
    },
    args.json,
  );
}
