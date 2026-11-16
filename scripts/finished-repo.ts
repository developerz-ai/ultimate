// Two finished rows read off the source tree alone: no shipped stub (a `NotImplementedError` built
// outside a test, a fixture and core's own definition, in a file no Known-Gaps row names) and no
// planned command (`PLANNED_COMMANDS` and `PLANNED_SUBCOMMANDS` both empty).

import { stripComments } from '../packages/core/src/source-mask';
import type { FinishedRow } from './finished-rule';
import { green, red } from './finished-rule';
import type { Finding } from './lib/log';
import { lineOf } from './lib/source-scan';

export const KNOWN_GAPS_PAGE = 'wiki/Known-Gaps.md';
export const PLANNED_FILE = 'packages/cli/src/cmd-planned.ts';
/** The one file allowed to construct the code: it declares the class and `notImplemented()`. */
const OWNER = 'packages/core/src/errors.ts';
const CONSTRUCTION = /\bnew\s+NotImplementedError\s*\(|(?<![\w.$]|function\s)notImplemented\s*\(/g;
const NOT_SHIPPED = /\.test\.tsx?$|[-.]fixtures?\.tsx?$/;

export interface SourceFile {
  readonly at: string;
  readonly text: string;
}

/** Every repo path a Known-Gaps table row names: a stub in one of those files is a decided gap. */
const pathsInRows = (markdown: string): string =>
  markdown
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .join('\n');

export function stubRow(files: readonly SourceFile[], knownGaps: string): FinishedRow {
  const rows = pathsInRows(knownGaps);
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.at === OWNER || NOT_SHIPPED.test(file.at) || rows.includes(file.at)) continue;
    for (const hit of stripComments(file.text).matchAll(CONSTRUCTION)) {
      const line = lineOf(file.text, hit.index);
      const at = `${file.at}:${line}`;
      findings.push({
        code: 'X_FINISHED_STUB',
        cause: `${at} builds a NotImplementedError in shipped code, and no ${KNOWN_GAPS_PAGE} row names ${file.at}: a stub nobody decided about is unfinished work`,
        fix: `edit ${file.at}:${line} — implement the path, or add a ${KNOWN_GAPS_PAGE} "Open by decision" row naming ${file.at} and why it stays`,
        at,
      });
    }
  }
  return findings.length === 0
    ? green('no-stub', `${files.length} shipped files, no undecided NotImplementedError`)
    : red(
        'no-stub',
        `${findings.length} shipped NotImplementedError site(s) no row names`,
        findings,
      );
}

export interface PlannedRead {
  readonly commands: readonly string[];
  readonly subcommands: readonly string[];
  /** `cmd-planned.ts`' source, so each finding opens at its row. */
  readonly source: string;
}

const rowLine = (source: string, name: string): number => {
  const at = source.search(new RegExp(`(?:name|subcommand): '${RegExp.escape(name)}'`));
  return at === -1 ? 1 : lineOf(source, at);
};

export function plannedRow(read: PlannedRead): FinishedRow {
  const planned = [
    ...read.commands.map((name) => ({ name, key: name })),
    ...read.subcommands.map((name) => ({ name, key: name.split(' ').at(-1) ?? name })),
  ];
  if (planned.length === 0) {
    return green('no-planned-command', 'PLANNED_COMMANDS and PLANNED_SUBCOMMANDS are empty');
  }
  const findings = planned.map(({ name, key }): Finding => {
    const line = rowLine(read.source, key);
    const at = `${PLANNED_FILE}:${line}`;
    return {
      code: 'X_FINISHED_PLANNED_COMMAND',
      cause: `x ${name} is a planned command (${at}): it parses and exits X_NOT_IMPLEMENTED, so the list of intended work is not empty`,
      fix: `edit ${PLANNED_FILE}:${line} — build x ${name}, or delete its row and record it in ${KNOWN_GAPS_PAGE} as "not planned; the extension point is …"`,
      at,
    };
  });
  return red(
    'no-planned-command',
    `${planned.length} planned: ${planned.map(({ name }) => `x ${name}`).join(', ')}`,
    findings,
  );
}
