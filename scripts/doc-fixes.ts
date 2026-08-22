#!/usr/bin/env bun
// Enforce, as a gate step, that the `Fix` column of `wiki/Error-Codes.md` is runnable — the same
// rule `x verify`'s `errors` step already applies to every `fix:` in shipped source.
//
// The gap this closes, in the audit's own words: `checkErrorFixes` resolves cited commands only for
// `fix:` string literals in shipped source; the reference page's `fix` column was held to coverage
// (every code has a row) and to registration (every row is a real code), never to RUNNABILITY. So
// the page an agent is sent to when it hits an error could print `x db query "select id …"` — and
// `x db` has no `query`.
//
// Same resolver as the source rule, same banned-phrase rule, one file set further on.
//
//   bun run scripts/doc-fixes.ts [--json]

import type { CommandCatalog } from '@ultimat3/cli';
import { citationFault, fixCitations, fixProblem, loadCommandCatalog } from '@ultimat3/cli';
import { docConfigKeyFindings } from './doc-config-keys';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isDelimiterRow, splitRow } from './wiki-tables';

/** The page the host repo publishes. `scripts/verify.ts` names the same file for the other half. */
export const FIX_REFERENCE = 'wiki/Error-Codes.md';

/** The header cell that marks the column. Matched case-insensitively, trimmed. */
export const FIX_HEADER = 'fix';

export interface FixCell {
  readonly line: number;
  readonly code: string;
  readonly fix: string;
}

/**
 * Every `Fix` cell on the page, with the code its row documents. Pure over the markdown.
 *
 * The column is found per table by its header rather than by position: the page carries a dozen
 * tables and not all of them are four columns wide, and a hardcoded index would read a `cause` as
 * a `fix` on the first table that gained a column.
 */
export function readFixCells(markdown: string): readonly FixCell[] {
  const lines = markdown.split('\n');
  const cells: FixCell[] = [];
  let column: number | undefined;
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      column = undefined;
      continue;
    }
    if (fenced) continue;
    if (!line.trim().startsWith('|')) {
      column = undefined;
      continue;
    }
    const row = splitRow(line);
    if (column === undefined) {
      if (!isDelimiterRow(lines[index + 1] ?? '')) continue;
      const found = row.findIndex((cell) => cell.trim().toLowerCase() === FIX_HEADER);
      column = found === -1 ? undefined : found;
      index += 1;
      continue;
    }
    const fix = (row[column] ?? '').trim();
    if (fix === '') continue;
    cells.push({
      line: index + 1,
      code: /`(X_[A-Z0-9_]+)`/.exec(row[0] ?? '')?.[1] ?? (row[0] ?? '').trim(),
      fix,
    });
  }
  return cells;
}

/**
 * `unrunnable` is the hazard. `advice` is the other half of the same contract — a fix that says
 * "check the connection" and names nothing. `vacuous` is the false green: a page with no `Fix`
 * header anywhere is a page this rule read and had no opinion about, which reads as agreement.
 */
export type DocFixGapKind = 'unrunnable' | 'advice' | 'vacuous';

export interface DocFixGap {
  readonly kind: DocFixGapKind;
  readonly line: number;
  readonly code: string;
  readonly problem: string;
}

export interface DocFixInput {
  /** The page's text, or `undefined` when it is not on disk. */
  readonly markdown: string | undefined;
  readonly catalog: CommandCatalog;
}

/**
 * Pure, so the negative case is a fixture rather than an edit to the page the wiki publishes.
 *
 * `allowPlanned` is deliberately OFF, and it is the whole point: `x cache`, `x logs` and
 * `x db studio` all parse and all exit `X_NOT_IMPLEMENTED`, so a row telling a reader to run one
 * hands them a second error in place of the fix for the first.
 */
export function checkDocFixes(input: DocFixInput): readonly DocFixGap[] {
  if (input.markdown === undefined) {
    return [{ kind: 'vacuous', line: 0, code: '', problem: `${FIX_REFERENCE} is not on disk` }];
  }
  const cells = readFixCells(input.markdown);
  if (cells.length === 0) {
    return [{ kind: 'vacuous', line: 0, code: '', problem: 'no table declares a `Fix` column' }];
  }
  const gaps: DocFixGap[] = [];
  for (const cell of cells) {
    const advice = fixProblem(cell.fix);
    if (advice !== undefined) {
      gaps.push({ kind: 'advice', line: cell.line, code: cell.code, problem: advice });
      continue;
    }
    for (const citation of fixCitations(cell.fix)) {
      const fault = citationFault(citation, input.catalog);
      if (fault === undefined) continue;
      gaps.push({
        kind: 'unrunnable',
        line: cell.line,
        code: cell.code,
        problem: `cites "${fault.subject}", ${fault.reason}`,
      });
      break;
    }
  }
  return gaps;
}

const where = (gap: DocFixGap): string => `${FIX_REFERENCE}:${gap.line}`;

const unrunnableFinding = (gap: DocFixGap): Finding => ({
  code: 'X_DOC_FIX_UNRUNNABLE',
  cause: `${where(gap)} is ${gap.code}'s fix and it ${gap.problem} — the page an agent is sent to when it hits ${gap.code} answers with a second failure`,
  fix: `rewrite ${gap.code}'s Fix cell at ${where(gap)} as an invocation this build ships; x help --json lists every command, subcommand and flag`,
  at: where(gap),
});

const adviceFinding = (gap: DocFixGap): Finding => ({
  code: 'X_DOC_FIX_UNRUNNABLE',
  cause: `${where(gap)} is ${gap.code}'s fix and ${gap.problem}`,
  fix: `rewrite ${gap.code}'s Fix cell at ${where(gap)} as a command to run, a call to paste, or an edit naming a file`,
  at: where(gap),
});

const vacuousFinding = (gap: DocFixGap): Finding => ({
  code: 'X_DOC_FIX_UNSCANNED',
  cause: `${gap.problem}, so this rule reported green over a fix column it never read`,
  fix: `restore ${FIX_REFERENCE} with a table whose header names a Fix column, or point FIX_REFERENCE in scripts/doc-fixes.ts at the page this repo publishes`,
  at: FIX_REFERENCE,
});

const FINDINGS: Readonly<Record<DocFixGapKind, (gap: DocFixGap) => Finding>> = {
  unrunnable: unrunnableFinding,
  advice: adviceFinding,
  vacuous: vacuousFinding,
};

export const docFixFindingFor = (gap: DocFixGap): Finding => FINDINGS[gap.kind](gap);

export async function docFixGaps(root: string): Promise<readonly DocFixGap[]> {
  const page = Bun.file(`${root}/${FIX_REFERENCE}`);
  return checkDocFixes({
    markdown: (await page.exists()) ? await page.text() : undefined,
    catalog: await loadCommandCatalog(),
  });
}

/**
 * What this repo contributes to `x verify`'s `errors` step: BOTH halves of "a fix is runnable".
 *
 * The command half is above. The CONFIG half is `doc-config-keys.ts` — a `fix:` may cite an
 * `app.config.ts` key as well as a command, and only the command was ever resolved, so
 * `set jobs.driver = 'pg' in app.config.ts` passed this rule while `jobs.driver` was deleted in
 * 5.0.0. Composed here rather than as a step of its own: same claim, same gate step, and a caller
 * that already imports one import gets the other.
 */
export const docFixFindings = async (root: string): Promise<readonly Finding[]> => [
  ...(await docFixGaps(root)).map(docFixFindingFor),
  ...(await docConfigKeyFindings(root)),
];

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const page = Bun.file(`${root}/${FIX_REFERENCE}`);
  const cells = (await page.exists()) ? readFixCells(await page.text()).length : 0;
  // `docFixFindings`, not `docFixGaps`: the standalone command must answer exactly what the gate
  // step answers, or `bun run scripts/doc-fixes.ts` prints green over a red `errors` step.
  const findings = await docFixFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: 'doc-fixes',
      summary:
        findings.length === 0
          ? `${cells} Fix cells in ${FIX_REFERENCE} and every documented app.config.ts key, all resolvable`
          : `${findings.length} unrunnable instruction(s) — ${cells} Fix cells in ${FIX_REFERENCE} read, plus every app.config.ts key the docs cite`,
      findings,
    },
    args.json,
  );
}
