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
// Same resolver as the source rule, same banned-phrase rule, one file set further on — plus the
// positional count the resolver does not make: a bare word the command's usage line has no slot
// for (`x routes list --json`) is unrunnable too (`scripts/lib/citation-arity.ts`).
//
//   bun run scripts/doc-fixes.ts [--json]

import type { CommandCatalog } from '@ultimat3/cli';
import { citationFault, fixCitations, fixProblem, loadCommandCatalog } from '@ultimat3/cli';
import { docConfigKeyFindings } from './doc-config-keys';
import { parseScriptArgs } from './lib/args';
import { arityFault } from './lib/citation-arity';
import { sameSentence } from './lib/error-code-plan';
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

interface TableRow {
  readonly line: number;
  /** The table's header cells, trimmed and lower-cased. */
  readonly header: readonly string[];
  readonly cells: readonly string[];
}

/**
 * Every body row of every table on the page, with its table's header. Fenced blocks are skipped:
 * a table inside one is an example, not a row the page documents.
 */
function tableRows(markdown: string): readonly TableRow[] {
  const lines = markdown.split('\n');
  const rows: TableRow[] = [];
  let header: readonly string[] | undefined;
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      header = undefined;
      continue;
    }
    if (fenced) continue;
    if (!line.trim().startsWith('|')) {
      header = undefined;
      continue;
    }
    const cells = splitRow(line);
    if (header === undefined) {
      if (!isDelimiterRow(lines[index + 1] ?? '')) continue;
      header = cells.map((cell) => cell.trim().toLowerCase());
      index += 1;
      continue;
    }
    rows.push({ line: index + 1, header, cells });
  }
  return rows;
}

const codeOf = (row: TableRow): string =>
  /`(X_[A-Z0-9_]+)`/.exec(row.cells[0] ?? '')?.[1] ?? (row.cells[0] ?? '').trim();

/**
 * Every `Fix` cell on the page, with the code its row documents. Pure over the markdown.
 *
 * The column is found per table by its header rather than by position: the page carries a dozen
 * tables and not all of them are four columns wide, and a hardcoded index would read a `cause` as
 * a `fix` on the first table that gained a column.
 */
export function readFixCells(markdown: string): readonly FixCell[] {
  return tableRows(markdown).flatMap((row) => {
    const column = row.header.indexOf(FIX_HEADER);
    const fix = column === -1 ? '' : (row.cells[column] ?? '').trim();
    return fix === '' ? [] : [{ line: row.line, code: codeOf(row), fix }];
  });
}

/** The two header cells a code row states what failed and why in. */
export const MEANS_HEADER = 'means';
export const CAUSE_HEADER = 'typical cause';

/**
 * Rows whose cause cell says what its title cell already said. `bun run new-error-code` wrote the
 * title into both cells when no cause was given, so the page read one sentence twice and the cause
 * not at all — the half of a row an agent reads to know what to look for.
 */
function causeEchoes(markdown: string): readonly DocFixGap[] {
  return tableRows(markdown).flatMap((row) => {
    const means = row.header.indexOf(MEANS_HEADER);
    const cause = row.header.indexOf(CAUSE_HEADER);
    if (means === -1 || cause === -1) return [];
    const title = (row.cells[means] ?? '').trim();
    if (title === '' || !sameSentence(title, row.cells[cause] ?? '')) return [];
    return [
      {
        kind: 'echoed' as const,
        line: row.line,
        code: codeOf(row),
        problem: `its Typical cause cell repeats its Means cell ("${title}")`,
      },
    ];
  });
}

/**
 * `unrunnable` is the hazard. `advice` is the other half of the same contract — a fix that says
 * "check the connection" and names nothing. `vacuous` is the false green: a page with no `Fix`
 * header anywhere is a page this rule read and had no opinion about, which reads as agreement.
 * `echoed` is a row whose cause cell is its title again, so the row never says why.
 */
export type DocFixGapKind = 'unrunnable' | 'advice' | 'vacuous' | 'echoed';

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
    const fault =
      fixCitations(cell.fix)
        .map((citation) => citationFault(citation, input.catalog))
        .find((one) => one !== undefined) ?? arityFault(cell.fix, input.catalog);
    if (fault === undefined) continue;
    gaps.push({
      kind: 'unrunnable',
      line: cell.line,
      code: cell.code,
      problem: `cites "${fault.subject}", ${fault.reason}`,
    });
  }
  return [...gaps, ...causeEchoes(input.markdown)];
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

const echoedFinding = (gap: DocFixGap): Finding => ({
  code: 'X_DOC_CAUSE_ECHOES_TITLE',
  cause: `${where(gap)} is ${gap.code}'s row and ${gap.problem} — the row states what failed twice and why it fails never`,
  fix: `edit ${gap.code}'s Typical cause cell at ${where(gap)} to name what usually makes it happen; a new code takes it as bun run new-error-code … --cause '…'`,
  at: where(gap),
});

const FINDINGS: Readonly<Record<DocFixGapKind, (gap: DocFixGap) => Finding>> = {
  unrunnable: unrunnableFinding,
  advice: adviceFinding,
  vacuous: vacuousFinding,
  echoed: echoedFinding,
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
