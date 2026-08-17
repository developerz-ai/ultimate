#!/usr/bin/env bun
// Enforce, as a gate step, that a command a doc page hands a reader is a command this build ships.
// The `errors` step resolves `x <command>` citations in shipped SOURCE and nothing resolved them
// in prose — so `x live explain`, `x db query`, `x db drift`, `x jobs run` and `x env check --fix`
// all sat in `wiki/` and `docs/` as instructions an agent runs once and gets X_CLI_UNKNOWN_COMMAND
// or X_CLI_BAD_FLAG from. Same resolver as the source rule (`@ultimat3/cli`'s `citationFault`),
// pointed at a second file set — a second resolver is the drift this repo forbids by name.
//
// Runs on `x verify`'s `manifest` step: does a committed file still describe this tree?
//
//   bun run scripts/doc-commands.ts [--json]

import type { CommandCatalog } from '@ultimat3/cli';
import { citationFault, loadCommandCatalog } from '@ultimat3/cli';
import type { DocCommandAllowance } from './doc-commands-allow';
import { DOC_COMMAND_ALLOWANCES } from './doc-commands-allow';
import { parseScriptArgs } from './lib/args';
import type { DocCitation, MarkdownFile } from './lib/doc-citations';
import { readMarkdown, scanDocCitations } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const DOC_GLOBS: readonly string[] = ['wiki/**/*.md', 'docs/**/*.md'];
export const ALLOW_FILE = 'scripts/doc-commands-allow.ts';

/**
 * Two pages this rule does not read, for two different reasons.
 *
 * `docs/plans/` is a dated record of work, not an instruction to a reader — and the audit that
 * produced this check quotes every broken command it found as evidence. A rule that failed on a bug
 * report is a rule that makes bug reports unwritable.
 *
 * `wiki/Error-Codes.md` belongs to `scripts/doc-fixes.ts`, which holds its `Fix` column to a
 * STRICTER rule than this one: a fix may not cite a planned command, and a doc sentence may. Two
 * reporters of one condition is the duplication this repo forbids by name, so the error reference
 * has exactly one owner.
 */
export const skipDocPath = (path: string): boolean =>
  path.startsWith('docs/plans/') || path === 'wiki/Error-Codes.md';

/**
 * `unresolved` is the hazard. `allowance` is the list's own hygiene — an entry matching nothing is
 * a waiver nobody reads, and the page it named may have been fixed or deleted. `vacuous` is the
 * false green: a glob that matches no file answers "every citation resolved" over nothing.
 */
export type DocCommandGapKind = 'unresolved' | 'allowance' | 'vacuous';

export interface DocCommandGap {
  readonly kind: DocCommandGapKind;
  readonly at: string;
  /** The invocation, spelled as it would be typed. Empty for `vacuous`. */
  readonly subject: string;
  readonly detail: string;
}

export interface DocCommandInput {
  readonly files: readonly MarkdownFile[];
  readonly catalog: CommandCatalog;
  readonly allow: readonly DocCommandAllowance[];
}

const allows = (allowance: DocCommandAllowance, path: string, subject: string): boolean =>
  allowance.path === path && allowance.cites === subject;

/**
 * Pure, so the negative case is a fixture rather than an edit to a page three other people are
 * rewriting. `allowPlanned` is on: the nine `PLANNED_COMMANDS` and `x db studio` are in the
 * registry, `x help` lists them, and `wiki/CLI-Reference.md` has a table whose whole job is to name
 * them. A `fix:` may not cite one; a sentence may.
 */
export function checkDocCommands(input: DocCommandInput): readonly DocCommandGap[] {
  if (input.files.length === 0) {
    return [
      {
        kind: 'vacuous',
        at: DOC_GLOBS.join(', '),
        subject: '',
        detail: 'no markdown file matched',
      },
    ];
  }
  const gaps: DocCommandGap[] = [];
  const used = new Set<DocCommandAllowance>();
  // One finding per line per invocation, not one per code span: a table row routinely writes
  // `x env check --fix` twice, and two identical findings read as two defects.
  const reported = new Set<string>();
  const cited: DocCitation[] = input.files.flatMap((file) => [...scanDocCitations(file)]);
  for (const one of cited) {
    const fault = citationFault(one.citation, input.catalog, { allowPlanned: true });
    if (fault === undefined) continue;
    const allowance = input.allow.find((entry) => allows(entry, one.path, fault.subject));
    if (allowance !== undefined) {
      used.add(allowance);
      continue;
    }
    const at = `${one.path}:${one.line}`;
    if (reported.has(`${at} ${fault.subject}`)) continue;
    reported.add(`${at} ${fault.subject}`);
    gaps.push({ kind: 'unresolved', at, subject: fault.subject, detail: fault.reason });
  }
  for (const allowance of input.allow) {
    if (used.has(allowance)) continue;
    gaps.push({
      kind: 'allowance',
      at: ALLOW_FILE,
      subject: allowance.cites,
      detail: allowance.path,
    });
  }
  return gaps;
}

const unresolvedFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_UNKNOWN',
  cause: `${gap.at} hands a reader "${gap.subject}", ${gap.detail}`,
  fix: `edit ${gap.at} to name an invocation this build ships — x help --json lists every command and its flags — or add { path, cites, kind, why } for it to DOC_COMMAND_ALLOWANCES in ${ALLOW_FILE} if the sentence is about the command NOT existing`,
  at: gap.at,
});

const allowanceFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_ALLOWANCE_STALE',
  cause: `${ALLOW_FILE} allows ${gap.detail} to name "${gap.subject}" and that page no longer does — a waiver nobody removes is a waiver nobody reads`,
  fix: `delete the { path: '${gap.detail}', cites: '${gap.subject}' } entry from DOC_COMMAND_ALLOWANCES in ${ALLOW_FILE}`,
  at: ALLOW_FILE,
});

const vacuousFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_UNSCANNED',
  cause: `${gap.detail} for ${gap.at}, so this rule reported green over a documentation surface it never read`,
  fix: `restore the documentation under wiki/ and docs/, or change DOC_GLOBS in scripts/doc-commands.ts to the paths this repo actually publishes`,
  at: gap.at,
});

const FINDINGS: Readonly<Record<DocCommandGapKind, (gap: DocCommandGap) => Finding>> = {
  unresolved: unresolvedFinding,
  allowance: allowanceFinding,
  vacuous: vacuousFinding,
};

export const docCommandFindingFor = (gap: DocCommandGap): Finding => FINDINGS[gap.kind](gap);

/** Read every documentation page once, whatever the glob list. */
export const readDocPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of DOC_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipDocPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};

export const docCommandGaps = async (root: string): Promise<readonly DocCommandGap[]> =>
  checkDocCommands({
    files: await readDocPages(root),
    catalog: await loadCommandCatalog(),
    allow: DOC_COMMAND_ALLOWANCES,
  });

/** What this repo contributes to `x verify`'s `manifest` step. */
export const docCommandFindings = async (root: string): Promise<readonly Finding[]> =>
  (await docCommandGaps(root)).map(docCommandFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const files = await readDocPages(root);
  const gaps = await docCommandGaps(root);
  report(
    {
      ok: gaps.length === 0,
      script: 'doc-commands',
      summary:
        gaps.length === 0
          ? `${files.length} pages, every documented x invocation resolves against the registry`
          : `${gaps.length} documented x invocation(s) this build cannot run, across ${files.length} pages`,
      findings: gaps.map(docCommandFindingFor),
    },
    args.json,
  );
}
